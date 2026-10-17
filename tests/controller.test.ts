import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store/db.js";
import { ScanController, recoverOrphans, type SandboxHandle } from "../server/scan/controller.js";
import { loadConfig } from "../server/config.js";
import type { AuthorSession, RepairFeedback, ScriptProposal } from "../server/agent/author.js";
import { baseResult, makePng } from "./helpers.js";

// These tests drive the real controller with a scripted fake sandbox and a
// scripted fake author. They verify the trusted loop's behaviour; they are NOT
// a live integration test (see tests/live/live.test.ts for that).

const GOOD = 'import { writeResult } from "/opt/teger/scout-kit.mjs";\n// good\nawait writeResult({});\n';
const BAD = 'import { writeResult } from "/opt/teger/scout-kit.mjs";\n// bad\nawait writeResult({});\n';

type Behaviour = (script: string, call: number) => { exitCode: number; stderr?: string; result?: unknown; png?: Buffer | null; hang?: boolean };

class FakeSandbox implements SandboxHandle {
  id = "sb-test-1";
  destroyed = false;
  egress: string[] = [];
  runs = 0;
  files = new Map<string, Buffer>();
  constructor(
    private behaviour: Behaviour,
    egress: string[],
  ) {
    this.egress = egress;
  }
  async verifyEgress(expected: string[]) {
    const ok = [...expected].sort().join() === [...this.egress].sort().join();
    return { ok, effective: this.egress, reason: ok ? undefined : "mismatch" };
  }
  async replaceEgress(rules: string[]) {
    this.egress = rules;
    return rules;
  }
  async probeBypass() {
    return { blocked: true, details: [{ target: "1.1.1.1:443", reachable: false }] };
  }
  async runtimeInfo() {
    return { node: "v22.0.0", chrome: "/usr/bin/google-chrome 141", os: "Ubuntu 24.04" };
  }
  async prepare() {}
  async writeTask() {}
  async runScript(script: string, _t: number, signal?: AbortSignal) {
    this.runs += 1;
    const b = this.behaviour(script, this.runs);
    if (b.hang) {
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    this.files.clear();
    if (b.result) this.files.set("/tmp/teger/out/result.json", Buffer.from(JSON.stringify(b.result)));
    if (b.png) this.files.set("/tmp/teger/out/screenshot.png", b.png);
    return { exitCode: b.exitCode, stdout: "", stderr: b.stderr ?? "", execMs: 10, timedOut: false };
  }
  async download(path: string) {
    return this.files.get(path) ?? null;
  }
  async destroy() {
    this.destroyed = true;
  }
}

class FakeAuthor implements AuthorSession {
  sessionId = "eve-session-test";
  repairs: RepairFeedback[] = [];
  constructor(private first: string) {}
  async write(): Promise<ScriptProposal> {
    return { script: this.first, explanation: "initial draft" };
  }
  async repair(f: RepairFeedback): Promise<ScriptProposal> {
    this.repairs.push(f);
    return { script: GOOD, explanation: "Waited for the form before reading it." };
  }
}

const resolver = async (h: string) => {
  const map: Record<string, string[]> = { "shop.example.org": ["93.184.215.14"], "next.example.net": ["93.184.216.34"], "evil-redirect.example.net": ["10.0.0.7"] };
  if (!map[h]) throw new Error("NXDOMAIN");
  return map[h];
};

function setup(behaviour: Behaviour, opts: { first?: string; deadlineMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "teger-test-"));
  process.env.TEGER_DATA_DIR = dir;
  process.env.TEGER_SCAN_DEADLINE_MS = String(opts.deadlineMs ?? 60_000);
  const cfg = loadConfig();
  const store = new Store(":memory:");
  let sandbox: FakeSandbox | null = null;
  const author = new FakeAuthor(opts.first ?? GOOD);
  const controller = new ScanController({
    cfg,
    store,
    resolver,
    createSandbox: async (_n, egress) => (sandbox = new FakeSandbox(behaviour, egress)),
    beginAuthor: async () => author,
    kitSource: async () => "// kit",
  });
  const scan = store.createScan({ owner: "o1", mode: "live", urlFull: "https://shop.example.org/", urlRedacted: "https://shop.example.org/", repairDemo: false });
  return { store, controller, scan, author, get sandbox() {
    return sandbox!;
  } };
}

describe("bounded write / run / repair loop", () => {
  beforeEach(() => {
    delete process.env.TEGER_MAX_ATTEMPTS;
  });

  it("repairs a genuinely failing script and returns a verified report", async () => {
    const t = setup((script) =>
      script.includes("// bad")
        ? { exitCode: 1, stderr: "TypeError: Cannot read properties of null (reading 'action')" }
        : { exitCode: 0, result: baseResult(), png: makePng(1280, 800) },
      { first: BAD },
    );
    await t.controller.run(t.scan.id);
    const scan = t.store.getScan(t.scan.id)!;
    expect(scan.status).toBe("completed");
    const attempts = t.store.listAttempts(t.scan.id);
    expect(attempts.map((a) => a.outcome)).toEqual(["failed", "passed"]);
    expect(attempts[0].script).toContain("// bad");
    expect(attempts[1].script).toContain("// good");
    expect(t.author.repairs[0].stderrExcerpt).toContain("TypeError");
    expect(t.author.repairs[0].failedChecks).toContain("script exited with status 1");
    expect(t.store.listArtifacts(t.scan.id)).toHaveLength(1);
    expect(t.sandbox.destroyed).toBe(true);
  });

  it("does not accept exit code 0 without a valid result and screenshot", async () => {
    const t = setup(() => ({ exitCode: 0, result: { contractVersion: 1 }, png: null }));
    await t.controller.run(t.scan.id);
    const attempts = t.store.listAttempts(t.scan.id);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.outcome === "failed")).toBe(true);
    const checks = JSON.parse(attempts[0].failed_checks_json!);
    expect(checks.join(" ")).toMatch(/screenshot check: screenshot file missing/);
    const report = JSON.parse(t.store.getScan(t.scan.id)!.report_json!);
    expect(report.preview.available).toBe(false);
    expect(t.sandbox.destroyed).toBe(true);
  });

  it("reports Preview unavailable and a partial inspection when only the screenshot fails", async () => {
    const t = setup(() => ({ exitCode: 0, result: baseResult({ screenshot: null, screenshotError: "Page.captureScreenshot timed out" }), png: null }));
    await t.controller.run(t.scan.id);
    const scan = t.store.getScan(t.scan.id)!;
    const report = JSON.parse(scan.report_json!);
    expect(scan.status).toBe("partial");
    expect(report.verdict).toBe("Inconclusive");
    expect(report.preview.reason).toMatch(/captureScreenshot timed out/);
  });

  it("revalidates redirect destinations before widening egress", async () => {
    const t = setup((_s, call) =>
      call === 1
        ? { exitCode: 0, result: baseResult({ finalUrl: "chrome-error://chromewebdata/", blockedRequests: [{ url: "https://next.example.net/landing", method: "GET", reason: "host-not-authorized", isDocument: true }] }), png: makePng(1280, 800) }
        : { exitCode: 0, result: baseResult({ finalUrl: "https://next.example.net/landing" }), png: makePng(1280, 800) },
    );
    await t.controller.run(t.scan.id);
    expect(t.sandbox.egress).toEqual(["93.184.215.14:443", "93.184.215.14:80", "93.184.216.34:443", "93.184.216.34:80"]);
    expect(t.store.getScan(t.scan.id)!.status).toBe("completed");
  });

  it("refuses redirects to private destinations and never adds them to egress", async () => {
    const t = setup(() => ({ exitCode: 0, result: baseResult({ finalUrl: "chrome-error://chromewebdata/", blockedRequests: [{ url: "http://evil-redirect.example.net/", method: "GET", reason: "host-not-authorized", isDocument: true }] }), png: makePng(1280, 800) }));
    await t.controller.run(t.scan.id);
    expect(t.sandbox.egress).toEqual(["93.184.215.14:443", "93.184.215.14:80"]);
    const report = JSON.parse(t.store.getScan(t.scan.id)!.report_json!);
    expect(report.blockedDestinations[0].reason).toMatch(/non-public/);
    expect(report.verdict).toBe("High risk");
  });

  it("blocks private destinations before any sandbox exists", async () => {
    const t = setup(() => ({ exitCode: 0 }));
    const s = t.store.createScan({ owner: "o1", mode: "live", urlFull: "http://169.254.169.254/latest/meta-data/", urlRedacted: "x", repairDemo: false });
    await t.controller.run(s.id);
    expect(t.store.getScan(s.id)!.status).toBe("blocked");
    expect(t.sandbox).toBeNull();
  });

  it("enforces the overall deadline and still destroys the sandbox", async () => {
    const t = setup(() => ({ exitCode: 0, hang: true }), { deadlineMs: 300 });
    await t.controller.run(t.scan.id);
    const scan = t.store.getScan(t.scan.id)!;
    expect(scan.error).toMatch(/deadline/);
    expect(t.sandbox.destroyed).toBe(true);
    expect(t.store.activeSandboxes()).toHaveLength(0);
  });

  it("cancels on request and cleans up", async () => {
    const t = setup(() => ({ exitCode: 0, hang: true }));
    const running = t.controller.run(t.scan.id);
    await new Promise((r) => setTimeout(r, 50));
    t.controller.cancel(t.scan.id);
    await running;
    expect(t.store.getScan(t.scan.id)!.status).toBe("cancelled");
    expect(t.sandbox.destroyed).toBe(true);
  });

  it("recovers orphaned sandboxes after a controller restart", async () => {
    const store = new Store(":memory:");
    const s = store.createScan({ owner: "o", mode: "live", urlFull: "https://a.example/", urlRedacted: "x", repairDemo: false });
    store.updateScan(s.id, { status: "running" });
    store.recordSandbox("sb-orphan", s.id);
    const destroyed: string[] = [];
    await recoverOrphans(store, async (id) => destroyed.push(id), () => {});
    expect(destroyed).toEqual(["sb-orphan"]);
    expect(store.getScan(s.id)!.status).toBe("failed");
    expect(store.activeSandboxes()).toHaveLength(0);
  });
});
