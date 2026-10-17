export interface Status {
  liveAvailable: boolean;
  accessCodeRequired: boolean;
  createosRegion: string | null;
  sandbox: { rootfs: string; shape: string };
  model: { provider: string; id: string };
  limits: { maxAttempts: number; deadlineSeconds: number };
  pilotDomains: string[];
  stages: Record<string, string>;
  fixtures: Array<{ key: string; path: string; url: string; label: string; expect: string }>;
}

export interface WarningSign {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export interface Report {
  verdict: "High risk" | "Suspicious" | "No obvious warning signs observed" | "Inconclusive";
  status: "completed" | "partial" | "failed";
  summary: string;
  recommendation: string;
  originalUrl: string | null;
  finalUrl: string | null;
  redirectChain: Array<{ url: string | null; status: number | null; kind: string }>;
  title: string | null;
  claimedIdentity: { name: string | null; supported: boolean; evidence: string[] } | null;
  loginForms: Array<{ action: string | null; method: string; crossOrigin: boolean; hasPassword: boolean }>;
  warningSigns: WarningSign[];
  blockedDestinations: Array<{ url: string; reason: string }>;
  preview: { available: boolean; artifactId?: string; width?: number; height?: number; reason?: string };
  coverage: string[];
  limitations: string[];
  executionMode: "live" | "fixture" | "recorded";
}

export interface ScanSummary {
  id: string;
  mode: "live" | "fixture" | "recorded";
  url: string;
  status: string;
  verdict: string | null;
  repairDemo: boolean;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  report?: Report;
  isDemo: boolean;
}

export interface Attempt {
  n: number;
  author: "model" | "seeded";
  script: string;
  sha256: string;
  explanation: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  outcome: string | null;
  failedChecks: string[];
  durationMs: number | null;
}

export interface ScanDetail {
  scan: ScanSummary;
  sandboxId: string | null;
  attempts: Attempt[];
  artifacts: Array<{ id: string; kind: string; mime: string; bytes: number; sha256: string; width: number | null; height: number | null }>;
}

export interface ScanEvent {
  seq: number;
  ts: string;
  stage: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
  data?: unknown;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const headers = { "content-type": "application/json", "x-teger-client": "web" };

export const api = {
  status: () => fetch("/api/status").then((r) => json<Status>(r)),
  scans: () => fetch("/api/scans").then((r) => json<{ scans: ScanSummary[] }>(r)),
  demos: () => fetch("/api/demo").then((r) => json<{ scans: ScanSummary[] }>(r)),
  scan: (id: string) => fetch(`/api/scans/${encodeURIComponent(id)}`).then((r) => json<ScanDetail>(r)),
  events: (id: string, after = 0) => fetch(`/api/scans/${encodeURIComponent(id)}/events?after=${after}`).then((r) => json<{ status: string; events: ScanEvent[] }>(r)),
  startLive: (url: string, accessCode: string, repairDemo: boolean) =>
    fetch("/api/scans", { method: "POST", headers, body: JSON.stringify({ url, accessCode, repairDemo, mode: "live" }) }).then((r) => json<{ id: string }>(r)),
  startFixture: (fixtureKey: string) => fetch("/api/scans", { method: "POST", headers, body: JSON.stringify({ mode: "fixture", fixtureKey }) }).then((r) => json<{ id: string }>(r)),
  cancel: (id: string) => fetch(`/api/scans/${encodeURIComponent(id)}/cancel`, { method: "POST", headers }).then((r) => json<{ ok: boolean }>(r)),
  artifactUrl: (scanId: string, artifactId: string) => `/api/scans/${encodeURIComponent(scanId)}/artifacts/${encodeURIComponent(artifactId)}`,
};
