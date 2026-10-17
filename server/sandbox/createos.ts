import { createClient, type CreateosSandboxClient, type Sandbox } from "@nodeops-createos/sandbox";
import { assertRestrictive, verifyEffectivePolicy } from "../policy/egress.js";
import type { AppConfig } from "../config.js";

export const KIT_DIR = "/opt/teger";
export const OUT_DIR = "/tmp/teger/out";
export const SCRIPT_PATH = `${KIT_DIR}/inspect.mjs`;

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  execMs: number;
  timedOut: boolean;
  agentError?: string;
}

export interface ProbeOutcome {
  blocked: boolean;
  details: Array<{ target: string; reachable: boolean }>;
}

export interface RuntimeInfo {
  node: string | null;
  chrome: string | null;
  os: string | null;
}

let sharedClient: CreateosSandboxClient | null = null;

export function sandboxClient(cfg: AppConfig): CreateosSandboxClient {
  if (!cfg.createos.apiKey) throw new Error("CREATEOS_SANDBOX_API_KEY is not configured");
  if (!sharedClient) {
    sharedClient = createClient({ apiKey: cfg.createos.apiKey, baseUrl: cfg.createos.baseUrl, timeoutMs: 90_000 });
  }
  return sharedClient;
}

/** A single scan's sandbox. Every method is trusted controller code. */
export class InspectionSandbox {
  private constructor(
    private sb: Sandbox,
    public readonly appliedEgress: string[],
  ) {}

  get id() {
    return this.sb.id;
  }

  static async create(cfg: AppConfig, name: string, egress: string[], signal?: AbortSignal): Promise<InspectionSandbox> {
    // Never create a sandbox whose policy would mean "allow all".
    assertRestrictive(egress);
    const client = sandboxClient(cfg);
    const sb = await client.createSandbox(
      {
        shape: cfg.createos.shape,
        rootfs: cfg.createos.rootfs,
        name,
        egress,
        // Safety net only: stops compute if the controller dies. It must exceed
        // the scan deadline or a slow model turn would pause a live scan.
        // Deletion is still explicit.
        auto_pause_after_seconds: Math.min(86_400, Math.ceil(cfg.limits.scanDeadlineMs / 1000) + 120),
      },
      { waitTimeoutMs: 120_000, signal },
    );
    return new InspectionSandbox(sb, egress);
  }

  static async connect(cfg: AppConfig, id: string) {
    const sb = await sandboxClient(cfg).getSandbox(id);
    return new InspectionSandbox(sb, []);
  }

  /** Resume the sandbox if the platform paused it; returns true when a resume was needed. */
  async ensureRunning(): Promise<boolean> {
    await this.sb.refresh();
    if (this.sb.status === "paused" || this.sb.status === "pausing") {
      if (this.sb.status === "pausing") await this.sb.waitUntilPaused({ timeoutMs: 60_000 });
      await this.sb.resume();
      await this.sb.waitUntilRunning({ timeoutMs: 120_000 });
      return true;
    }
    return false;
  }

  async readEgress(): Promise<string[]> {
    const view = await this.sb.getEgress();
    return view.egress ?? [];
  }

  async replaceEgress(rules: string[]): Promise<string[]> {
    assertRestrictive(rules);
    const view = await this.sb.setEgress(rules);
    return view.egress ?? [];
  }

  async verifyEgress(expected: string[]) {
    const effective = await this.readEgress();
    return { ...verifyEffectivePolicy(expected, effective), effective };
  }

  /**
   * Prove direct outbound bypass is blocked: raw TCP from the VM to public
   * addresses that are not on the allowlist must fail. Uses bash /dev/tcp so it
   * does not depend on curl or node being present.
   */
  async probeBypass(allowedIps: string[]): Promise<ProbeOutcome> {
    const candidates = ["1.1.1.1:443", "8.8.8.8:53", "9.9.9.9:443", "208.67.222.222:443"].filter((t) => !allowedIps.includes(t.split(":")[0])).slice(0, 2);
    const details: ProbeOutcome["details"] = [];
    for (const t of candidates) {
      const [ip, port] = t.split(":");
      const r = await this.sb.runCommand("bash", ["-c", `timeout 4 bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null && echo OPEN || echo CLOSED`], { timeoutMs: 20_000 });
      details.push({ target: t, reachable: r.result.stdout.includes("OPEN") });
    }
    return { blocked: details.length > 0 && details.every((d) => !d.reachable), details };
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    const r = await this.sb.runCommand(
      "bash",
      [
        "-c",
        [
          'echo "node=$(node --version 2>/dev/null)"',
          'for c in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/chrome /usr/bin/chromium /usr/bin/chromium-browser; do if [ -x "$c" ]; then echo "chrome=$c $($c --version 2>/dev/null | head -1)"; break; fi; done',
          'echo "os=$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME)"',
        ].join("; "),
      ],
      { timeoutMs: 30_000 },
    );
    const get = (k: string) => r.result.stdout.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() || null;
    return { node: get("node"), chrome: get("chrome"), os: get("os") };
  }

  async prepare(kitSource: string, task: unknown) {
    await this.sb.runCommand("bash", ["-c", `mkdir -p ${KIT_DIR} ${OUT_DIR}`], { timeoutMs: 20_000 });
    await this.sb.files.upload(`${KIT_DIR}/scout-kit.mjs`, kitSource);
    await this.writeTask(task);
  }

  async writeTask(task: unknown) {
    await this.sb.files.upload(`${KIT_DIR}/task.json`, JSON.stringify(task));
  }

  async runScript(script: string, timeoutSec: number, signal?: AbortSignal): Promise<RunOutcome> {
    await this.sb.runCommand("bash", ["-c", `rm -rf ${OUT_DIR} && mkdir -p ${OUT_DIR}`], { timeoutMs: 20_000 });
    await this.sb.files.upload(SCRIPT_PATH, script);
    const started = Date.now();
    // The run configuration is fixed by the controller; the model only supplies script text.
    const r = await this.sb.runCommand("timeout", ["-k", "3", String(timeoutSec), "node", SCRIPT_PATH], {
      timeoutMs: (timeoutSec + 30) * 1000,
      signal,
    });
    const code = r.result.exit_code;
    return {
      exitCode: code,
      stdout: r.result.stdout,
      stderr: r.result.stderr,
      execMs: r.exec_ms ?? Date.now() - started,
      timedOut: code === 124 || code === 137,
      agentError: r.result.error,
    };
  }

  async download(path: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const ab = await this.sb.files.download(path, { timeoutMs: 60_000 });
      if (ab.byteLength > maxBytes) return null;
      return Buffer.from(ab);
    } catch {
      return null;
    }
  }

  async destroy(): Promise<void> {
    await this.sb.destroy();
    try {
      await this.sb.waitUntilDestroyed({ timeoutMs: 60_000 });
    } catch {
      /* destroy was accepted; reclamation continues server-side */
    }
  }
}

/** Destroy any sandbox the controller created but did not clean up (e.g. after a crash). */
export async function destroyById(cfg: AppConfig, id: string): Promise<"destroyed" | "missing"> {
  try {
    const sb = await sandboxClient(cfg).getSandbox(id);
    if (sb.status !== "destroyed" && sb.status !== "destroying") await sb.destroy();
    return "destroyed";
  } catch (e) {
    if ((e as { name?: string }).name === "CreateosSandboxNotFoundError") return "missing";
    throw e;
  }
}

export async function listTegerSandboxes(cfg: AppConfig): Promise<Array<{ id: string; name?: string; status: string }>> {
  const all = await sandboxClient(cfg).listSandboxes();
  return all.filter((s) => s.name?.startsWith("teger-") && s.status !== "destroyed").map((s) => ({ id: s.id, name: s.name, status: s.status }));
}
