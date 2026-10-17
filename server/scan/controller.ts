import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";
import { authorizeHost, parseTarget, redactUrl, UrlPolicyError, type AuthorizedHost, type Resolver } from "../policy/url.js";
import { buildEgressRules, buildResolverRules } from "../policy/egress.js";
import { resultSchema, validateScreenshot, type InspectionResult } from "./contract.js";
import { buildReport, type BlockedDestination } from "./report.js";
import { checkScript, normalizeScript } from "../agent/script-check.js";
import type { AuthorSession, ScriptProposal } from "../agent/author.js";
import { OUT_DIR } from "../sandbox/createos.js";

/** What the controller needs from a sandbox. InspectionSandbox implements it. */
export interface SandboxHandle {
  id: string;
  verifyEgress(expected: string[]): Promise<{ ok: boolean; reason?: string; effective: string[] }>;
  replaceEgress(rules: string[]): Promise<string[]>;
  probeBypass(allowedIps: string[]): Promise<{ blocked: boolean; details: Array<{ target: string; reachable: boolean }> }>;
  runtimeInfo(): Promise<{ node: string | null; chrome: string | null; os: string | null }>;
  prepare(kitSource: string, task: unknown): Promise<void>;
  writeTask(task: unknown): Promise<void>;
  runScript(script: string, timeoutSec: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; execMs: number; timedOut: boolean; agentError?: string }>;
  download(path: string, maxBytes: number): Promise<Buffer | null>;
  destroy(): Promise<void>;
}

export interface ControllerDeps {
  cfg: AppConfig;
  store: Store;
  createSandbox: (name: string, egress: string[], signal: AbortSignal) => Promise<SandboxHandle>;
  beginAuthor: (signal: AbortSignal) => Promise<AuthorSession>;
  kitSource: () => Promise<string>;
  resolver?: Resolver;
  /** Seeded first draft for the labelled repair demonstration. */
  seededDraft?: () => Promise<string>;
}

export const STAGES = {
  validate: "Validating URL",
  prepare: "Preparing isolated browser",
  write: "Writing inspection code",
  run: "Running inspection",
  repair: "Repairing code",
  collect: "Collecting evidence",
  report: "Preparing report",
  cleanup: "Cleaning up",
} as const;
export type Stage = keyof typeof STAGES;

class ScanAborted extends Error {}

const excerpt = (s: string, max = 2000) => {
  // Redact anything that looks like a credential before it is stored or shown.
  const redacted = s.replace(/(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "[redacted]").replace(/(api[_-]?key|token|password)=\S+/gi, "$1=[redacted]");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
};

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

interface AttemptEvaluation {
  ok: boolean;
  failedChecks: string[];
  result: InspectionResult | null;
  screenshot: Buffer | null;
  screenshotInfo?: { width: number; height: number };
  screenshotReason?: string;
  newDocumentHosts: string[];
}

export class ScanController {
  private aborts = new Map<string, AbortController>();

  constructor(private deps: ControllerDeps) {}

  cancel(scanId: string) {
    this.deps.store.updateScan(scanId, { cancel_requested: 1 });
    this.aborts.get(scanId)?.abort(new ScanAborted("cancelled by user"));
  }

  isRunning(scanId: string) {
    return this.aborts.has(scanId);
  }

  private event(scanId: string, stage: Stage | "policy" | "agent", level: "info" | "warn" | "error" | "success", message: string, data?: unknown) {
    this.deps.store.appendEvent(scanId, stage, level, message, data);
  }

  async run(scanId: string): Promise<void> {
    const { cfg, store } = this.deps;
    const scan = store.getScan(scanId);
    if (!scan) throw new Error(`unknown scan ${scanId}`);
    const ac = new AbortController();
    this.aborts.set(scanId, ac);
    const deadline = setTimeout(() => ac.abort(new ScanAborted(`overall deadline of ${Math.round(cfg.limits.scanDeadlineMs / 1000)}s reached`)), cfg.limits.scanDeadlineMs);
    const signal = ac.signal;
    const check = () => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new ScanAborted(String(signal.reason));
    };

    store.updateScan(scanId, { status: "running" });
    let sandbox: SandboxHandle | null = null;
    const authorized: AuthorizedHost[] = [];
    const blockedDestinations: BlockedDestination[] = [];
    let egressVerified = false;
    let attempts = 0;
    let final: AttemptEvaluation | null = null;
    let requestedHost = "";
    let isIpLiteral = false;
    let failure: string | null = null;

    try {
      // 1. Validate the task and approved destination (trusted, deterministic).
      this.event(scanId, "validate", "info", "Checking the link against the network policy");
      let parsed;
      try {
        parsed = parseTarget(scan.url_full);
        requestedHost = parsed.host;
        isIpLiteral = parsed.isIpLiteral;
        authorized.push(await authorizeHost(parsed.host, { resolver: this.deps.resolver, pilotDomains: cfg.pilotDomains }));
      } catch (e) {
        if (e instanceof UrlPolicyError) {
          this.event(scanId, "validate", "error", e.message, { code: e.code });
          const report = buildReport({
            requestedUrl: scan.url_full,
            requestedHost: requestedHost || "unknown",
            isIpLiteral,
            result: null,
            screenshot: { ok: false, reason: "not attempted: destination blocked by policy" },
            blockedDestinations: [{ url: scan.url_full, reason: e.message }],
            authorizedHosts: [],
            egressVerified: false,
            attempts: 0,
            executionMode: "live",
          });
          store.updateScan(scanId, { status: "blocked", verdict: report.verdict, report_json: JSON.stringify(report), error: e.message, finished_at: new Date().toISOString() });
          return;
        }
        throw e;
      }
      this.event(scanId, "validate", "success", `Destination allowed: ${parsed.host} → ${authorized[0].ips.join(", ")} (public addresses only)`);

      // 2. Prepare the isolated browser with a least-privilege egress policy
      //    applied at creation time, before any generated code exists.
      check();
      const rules = buildEgressRules(authorized);
      this.event(scanId, "prepare", "info", `Creating CreateOS sandbox (${cfg.createos.rootfs}, ${cfg.createos.shape}) with ${rules.length} egress rules`, { egress: rules });
      sandbox = await this.deps.createSandbox(`teger-${scanId.slice(4, 16)}`, rules, signal);
      store.recordSandbox(sandbox.id, scanId);
      store.updateScan(scanId, { sandbox_id: sandbox.id });
      this.event(scanId, "prepare", "info", `Sandbox ${sandbox.id} is running`);

      const verify = await sandbox.verifyEgress(rules);
      if (!verify.ok) throw new Error(`Egress verification failed: ${verify.reason}`);
      const probe = await sandbox.probeBypass(authorized.flatMap((h) => h.ips));
      if (!probe.blocked) throw new Error(`Egress bypass probe reached a non-allowlisted address: ${JSON.stringify(probe.details)}`);
      egressVerified = true;
      this.event(scanId, "policy", "success", "Egress policy read back from CreateOS and direct-connection probe blocked", { effective: verify.effective, probe: probe.details });

      const runtime = await sandbox.runtimeInfo();
      this.event(scanId, "prepare", "info", `Sandbox runtime: ${runtime.os ?? "unknown OS"}; Node ${runtime.node ?? "missing"}; ${runtime.chrome ?? "no Chrome found"}`, runtime);
      if (!runtime.node) throw new Error("Sandbox image has no Node.js runtime");
      if (!runtime.chrome) throw new Error("Sandbox image has no Chrome/Chromium");

      const task = () => ({
        url: parsed.href,
        allowedHosts: authorized.map((h) => h.host),
        resolverRules: buildResolverRules(authorized),
        limits: { navigationTimeoutMs: cfg.limits.navigationTimeoutMs },
        viewport: { width: 1280, height: 800 },
        outDir: OUT_DIR,
      });
      await sandbox.prepare(await this.deps.kitSource(), task());
      this.event(scanId, "prepare", "success", "Trusted helper and task file installed in the sandbox");

      // 3. Ask the model for an inspection script (or use the labelled seeded draft).
      check();
      const author = await this.deps.beginAuthor(signal);
      let proposal: ScriptProposal;
      let proposalAuthor: "model" | "seeded" = "model";
      if (scan.repair_demo && this.deps.seededDraft) {
        proposal = { script: await this.deps.seededDraft(), explanation: "Seeded draft for the repair demonstration. Contains a deliberate, documented defect. Not written by the model." };
        proposalAuthor = "seeded";
        this.event(scanId, "write", "warn", "Repair demonstration: attempt 1 uses a deliberately defective seeded draft (see docs/REPAIR_DEMO.md)");
      } else {
        this.event(scanId, "write", "info", "Asking the inspection agent (eve) to write the script");
        proposal = await author.write({ attemptBudget: cfg.limits.maxAttempts, timeoutSec: cfg.limits.scriptTimeoutSec });
        this.event(scanId, "write", "success", `Agent wrote ${proposal.script.split("\n").length} lines: ${proposal.explanation}`, { eveSession: author.sessionId });
      }

      let expansions = 0;
      while (attempts < cfg.limits.maxAttempts) {
        check();
        attempts += 1;
        const script = normalizeScript(proposal.script);
        const attemptId = store.startAttempt(scanId, attempts, proposalAuthor, script, sha256(script), proposal.explanation);
        const staticProblems = checkScript(script);
        let evaluation: AttemptEvaluation;
        let run = { exitCode: null as number | null, stdout: "", stderr: "", execMs: 0, timedOut: false };

        if (staticProblems.length > 0) {
          evaluation = { ok: false, failedChecks: staticProblems, result: null, screenshot: null, newDocumentHosts: [] };
          this.event(scanId, "run", "warn", `Attempt ${attempts} rejected before execution: ${staticProblems[0]}`);
        } else {
          this.event(scanId, "run", "info", `Attempt ${attempts}: running ${proposalAuthor === "seeded" ? "seeded draft" : "agent-written script"} in the sandbox (limit ${cfg.limits.scriptTimeoutSec}s)`);
          run = await sandbox.runScript(script, cfg.limits.scriptTimeoutSec, signal);
          evaluation = await this.evaluate(sandbox, run, parsed.href, authorized);

          // Redirects to new hosts: validate deterministically, then (and only then)
          // widen egress by exactly those validated IPs and re-run the same script.
          while (evaluation.newDocumentHosts.length > 0 && expansions < cfg.limits.maxHostExpansions) {
            check();
            let widened = false;
            for (const host of evaluation.newDocumentHosts) {
              try {
                const a = await authorizeHost(host, { resolver: this.deps.resolver, pilotDomains: cfg.pilotDomains });
                authorized.push(a);
                widened = true;
                this.event(scanId, "policy", "info", `Redirect destination ${host} validated (${a.ips.join(", ")}); authorizing it`);
              } catch (e) {
                const reason = e instanceof UrlPolicyError ? e.message : "validation error";
                blockedDestinations.push({ url: `http://${host}/`, reason });
                this.event(scanId, "policy", "warn", `Redirect to ${host} refused: ${reason}`);
              }
            }
            if (!widened) break;
            expansions += 1;
            const newRules = buildEgressRules(authorized);
            await sandbox.replaceEgress(newRules);
            const v = await sandbox.verifyEgress(newRules);
            if (!v.ok) throw new Error(`Egress verification failed after redirect authorization: ${v.reason}`);
            await sandbox.writeTask(task());
            this.event(scanId, "run", "info", `Re-running attempt ${attempts} with ${authorized.length} authorized hosts`);
            run = await sandbox.runScript(script, cfg.limits.scriptTimeoutSec, signal);
            evaluation = await this.evaluate(sandbox, run, parsed.href, authorized);
          }
          if (evaluation.newDocumentHosts.length > 0 && expansions >= cfg.limits.maxHostExpansions) {
            for (const h of evaluation.newDocumentHosts) blockedDestinations.push({ url: `http://${h}/`, reason: "redirect limit reached" });
          }
        }

        store.finishAttempt(attemptId, {
          exit_code: run.exitCode,
          stdout_excerpt: excerpt(run.stdout),
          stderr_excerpt: excerpt(run.stderr),
          outcome: evaluation.ok ? "passed" : "failed",
          failed_checks: evaluation.failedChecks,
          duration_ms: run.execMs,
        });
        final = evaluation;

        if (evaluation.ok) {
          this.event(scanId, "run", "success", `Attempt ${attempts} passed every acceptance check`);
          break;
        }
        this.event(scanId, "run", "warn", `Attempt ${attempts} failed: ${evaluation.failedChecks.slice(0, 3).join("; ")}`, { exitCode: run.exitCode, stderr: excerpt(run.stderr, 600) });
        if (attempts >= cfg.limits.maxAttempts) break;

        // 4. Targeted repair: the model gets the error and the code, nothing else.
        check();
        this.event(scanId, "repair", "info", "Sending the error and the script back to the agent for a targeted repair");
        proposal = await author.repair({
          attempt: attempts,
          previousScript: script,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          failedChecks: evaluation.failedChecks,
          stdoutExcerpt: excerpt(run.stdout, 1500),
          stderrExcerpt: excerpt(run.stderr, 3000),
        });
        proposalAuthor = "model";
        this.event(scanId, "repair", "success", `Agent repair: ${proposal.explanation}`);
      }
    } catch (e) {
      failure = signal.aborted ? (signal.reason as Error)?.message ?? "aborted" : (e as Error).message;
      this.event(scanId, "run", "error", `Inspection stopped: ${excerpt(failure, 500)}`);
    } finally {
      clearTimeout(deadline);
      // 5. Collect evidence (validated artifacts only) and build the report.
      let screenshotArtifact: { id: string; width: number; height: number } | null = null;
      try {
        if (final?.screenshot && final.screenshotInfo) {
          this.event(scanId, "collect", "info", "Storing the verified screenshot in controlled storage");
          const dir = join(cfg.artifactDir, scanId);
          await mkdir(dir, { recursive: true });
          const path = join(dir, "screenshot.png");
          await writeFile(path, final.screenshot);
          const art = store.addArtifact({ scan_id: scanId, kind: "screenshot", mime: "image/png", bytes: final.screenshot.length, sha256: sha256(final.screenshot), width: final.screenshotInfo.width, height: final.screenshotInfo.height, path });
          screenshotArtifact = { id: art.id, width: art.width!, height: art.height! };
          this.event(scanId, "collect", "success", `Screenshot verified (${art.width}x${art.height}, ${Math.round(art.bytes / 1024)} KB)`);
        } else if (requestedHost) {
          this.event(scanId, "collect", "warn", `Preview unavailable: ${final?.screenshotReason ?? failure ?? "no screenshot produced"}`);
        }
      } catch (e) {
        this.event(scanId, "collect", "error", `Could not store evidence: ${(e as Error).message}`);
      }

      if (requestedHost) {
        this.event(scanId, "report", "info", "Scoring evidence with deterministic rules");
        const result = final?.result ?? null;
        const report = buildReport({
          requestedUrl: scan.url_full,
          requestedHost,
          isIpLiteral,
          result,
          screenshot: screenshotArtifact ? { ok: true, artifactId: screenshotArtifact.id, width: screenshotArtifact.width, height: screenshotArtifact.height } : { ok: false, reason: final?.screenshotReason ?? failure ?? "no screenshot produced" },
          blockedDestinations,
          authorizedHosts: authorized.map((h) => h.host),
          egressVerified,
          attempts,
          executionMode: "live",
        });
        const cancelled = store.getScan(scanId)?.cancel_requested === 1;
        const status = cancelled ? "cancelled" : report.status;
        store.updateScan(scanId, { status, verdict: report.verdict, report_json: JSON.stringify(report), error: failure });
        this.event(scanId, "report", report.status === "completed" ? "success" : "warn", `Verdict: ${report.verdict}`);
      }

      // 6. Always clean up, on success, error, timeout and cancellation.
      if (sandbox) {
        this.event(scanId, "cleanup", "info", `Destroying sandbox ${sandbox.id}`);
        try {
          await sandbox.destroy();
          store.markSandboxDestroyed(sandbox.id);
          this.event(scanId, "cleanup", "success", "Sandbox destroyed");
        } catch (e) {
          this.event(scanId, "cleanup", "error", `Sandbox destroy failed; recovery will retry: ${(e as Error).message}`);
        }
      } else {
        this.event(scanId, "cleanup", "info", "No sandbox to clean up");
      }
      store.updateScan(scanId, { finished_at: new Date().toISOString() });
      this.aborts.delete(scanId);
    }
  }

  /** Trusted acceptance checks. A zero exit code alone is never enough. */
  private async evaluate(
    sandbox: SandboxHandle,
    run: { exitCode: number | null; stderr: string; timedOut: boolean; agentError?: string },
    requestedHref: string,
    authorized: AuthorizedHost[],
  ): Promise<AttemptEvaluation> {
    const failed: string[] = [];
    if (run.agentError) failed.push(`sandbox could not start the command: ${run.agentError}`);
    if (run.timedOut) failed.push("script exceeded the controller time limit");
    else if (run.exitCode !== 0) failed.push(`script exited with status ${run.exitCode}`);

    const rawResult = await sandbox.download(`${OUT_DIR}/result.json`, 300 * 1024);
    let result: InspectionResult | null = null;
    if (!rawResult) failed.push("result.json missing (writeResult was not called or failed)");
    else {
      try {
        const parsedJson = JSON.parse(rawResult.toString("utf8"));
        const v = resultSchema.safeParse(parsedJson);
        if (v.success) result = v.data;
        else failed.push(...v.error.issues.slice(0, 6).map((i) => `result.${i.path.join(".") || "(root)"}: ${i.message}`));
      } catch {
        failed.push("result.json is not valid JSON");
      }
    }

    const authorizedNames = new Set(authorized.map((h) => h.host));
    const newHosts = new Set<string>();
    if (result) {
      if (result.requestedUrl !== requestedHref) failed.push("result.requestedUrl does not match the authorized task URL");
      for (const b of result.blockedRequests) {
        if (b.isDocument && b.reason === "host-not-authorized") {
          try {
            const h = new URL(b.url).hostname.toLowerCase();
            if (h && !authorizedNames.has(h)) newHosts.add(h);
          } catch {
            /* malformed URL from the page; ignore */
          }
        }
      }
      if (result.finalUrl && !result.finalUrl.startsWith("chrome-error:")) {
        try {
          const fh = new URL(result.finalUrl).hostname.toLowerCase();
          if (fh && !authorizedNames.has(fh) && !newHosts.has(fh)) failed.push(`result.finalUrl host ${fh} was never authorized (inconsistent result)`);
        } catch {
          failed.push("result.finalUrl is not a valid URL");
        }
      }
    }

    const shot = await sandbox.download(`${OUT_DIR}/screenshot.png`, 7 * 1024 * 1024);
    const sv = validateScreenshot(shot);
    let screenshotReason: string | undefined;
    if (!sv.ok) {
      screenshotReason = result?.screenshotError ? `${sv.reason} (script reported: ${result.screenshotError.slice(0, 200)})` : sv.reason;
      failed.push(`screenshot check: ${sv.reason}`);
    }

    return {
      ok: failed.length === 0 && newHosts.size === 0,
      failedChecks: newHosts.size > 0 && failed.length === 0 ? ["navigation reached a host that is not yet authorized"] : failed,
      result,
      screenshot: sv.ok ? shot : null,
      screenshotInfo: sv.ok ? sv.info : undefined,
      screenshotReason,
      newDocumentHosts: [...newHosts],
    };
  }
}

/** On startup: fail scans left running by a previous process and destroy their sandboxes. */
export async function recoverOrphans(store: Store, destroy: (id: string) => Promise<unknown>, log: (m: string) => void) {
  for (const s of store.activeLiveScans()) {
    store.appendEvent(s.id, "cleanup", "error", "Controller restarted during this inspection; marking it failed and cleaning up");
    store.updateScan(s.id, { status: "failed", error: "controller restarted", finished_at: new Date().toISOString() });
  }
  for (const sb of store.activeSandboxes()) {
    try {
      await destroy(sb.id);
      store.markSandboxDestroyed(sb.id);
      store.appendEvent(sb.scan_id, "cleanup", "success", `Recovered orphaned sandbox ${sb.id} and destroyed it`);
      log(`recovered orphaned sandbox ${sb.id}`);
    } catch (e) {
      log(`orphan recovery failed for ${sb.id}: ${(e as Error).message}`);
    }
  }
}

export async function loadKit(path: string) {
  return readFile(path, "utf8");
}

export { redactUrl };
