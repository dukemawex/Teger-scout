// Runs ONE live scan of a project fixture page on a deployed Teger Scout via
// its public API, waits for it, and saves it as recorded evidence in
// recorded/<name>.json + .png (the format server/recorded.ts imports).
// Only fixture URLs are accepted, so no real user data is ever exported.
// Usage: TEGER_LIVE_ACCESS_CODE=... node scripts/capture-recorded.mjs <baseUrl> <fixtureKey> <name> [--repair-demo]
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [base, fixtureKey, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const repairDemo = process.argv.includes("--repair-demo");
let cookie = "";
const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie, "x-teger-client": "web", "content-type": "application/json" } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
};

const status = await (await call("/api/status")).json();
const fixture = status.fixtures.find((f) => f.key === fixtureKey);
if (!fixture || !fixture.url.startsWith(base)) throw new Error("unknown fixture or fixture not on this deployment");
const started = await call("/api/scans", { method: "POST", body: JSON.stringify({ url: fixture.url, accessCode: process.env.TEGER_LIVE_ACCESS_CODE, repairDemo }) });
if (started.status !== 202) throw new Error(`scan refused: ${started.status} ${await started.text()}`);
const { id } = await started.json();
console.log("scan", id);
let detail;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  detail = await (await call(`/api/scans/${id}`)).json();
  if (!["queued", "running"].includes(detail.scan.status) && detail.scan.finishedAt) break;
}
const events = (await (await call(`/api/scans/${id}/events`)).json()).events;
const out = join(import.meta.dirname, "../recorded");
await mkdir(out, { recursive: true });
let screenshot;
const art = detail.artifacts.find((a) => a.kind === "screenshot");
if (art) {
  const buf = Buffer.from(await (await call(`/api/scans/${id}/artifacts/${art.id}`)).arrayBuffer());
  await writeFile(join(out, `${name}.png`), buf);
  screenshot = { file: `${name}.png`, sha256: createHash("sha256").update(buf).digest("hex"), width: art.width, height: art.height, bytes: buf.length, artifactId: art.id };
}
const report = detail.scan.report;
if (report) report.executionMode = "recorded";
await writeFile(
  join(out, `${name}.json`),
  JSON.stringify(
    {
      id: `rec_${name}`,
      sourceScanId: id,
      sourceDeployment: base,
      url: detail.scan.url,
      status: detail.scan.status,
      verdict: detail.scan.verdict,
      repairDemo: detail.scan.repairDemo,
      createdAt: detail.scan.createdAt,
      finishedAt: detail.scan.finishedAt,
      sandboxId: detail.sandboxId,
      report,
      events: events.map((e) => ({ stage: e.stage, level: e.level, message: e.message, data: e.data, ts: e.ts })),
      attempts: detail.attempts.map((a) => ({ n: a.n, author: a.author, script: a.script, sha256: a.sha256, explanation: a.explanation, exitCode: a.exitCode, stdout: a.stdout ?? "", stderr: a.stderr ?? "", outcome: a.outcome ?? "", failedChecks: a.failedChecks, durationMs: a.durationMs, startedAt: a.startedAt })),
      screenshot,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ id, status: detail.scan.status, verdict: detail.scan.verdict, sandbox: detail.sandboxId, attempts: detail.attempts.map((a) => `${a.n}:${a.author}:${a.outcome}:exit${a.exitCode}`), screenshot: !!screenshot }));
process.exit(0);
