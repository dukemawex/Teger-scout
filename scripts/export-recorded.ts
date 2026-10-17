// Exports a completed LIVE scan of a project fixture page into recorded/ so it
// can be shown read-only as "Recorded evidence from a live run".
// Usage: tsx scripts/export-recorded.ts <dbPath> <scanId> <name>
// Refuses scans of non-fixture URLs so no real user data is ever published.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../server/store/db.js";

const [dbPath, scanId, name] = process.argv.slice(2);
if (!dbPath || !scanId || !name) throw new Error("usage: export-recorded.ts <dbPath> <scanId> <name>");
const store = new Store(dbPath);
const scan = store.getScan(scanId);
if (!scan) throw new Error("scan not found");
if (scan.mode !== "live") throw new Error("only live scans can be exported as recorded evidence");
if (!new URL(scan.url_full).pathname.startsWith("/fixtures/")) throw new Error("refusing to export a scan of a non-fixture URL");

const out = join(import.meta.dirname, "../recorded");
await mkdir(out, { recursive: true });
const report = JSON.parse(scan.report_json ?? "null");
if (report) report.executionMode = "recorded";
const art = store.listArtifacts(scanId).find((a) => a.kind === "screenshot");
let screenshot;
if (art) {
  const file = `${name}.png`;
  await copyFile(art.path, join(out, file));
  screenshot = { file, sha256: art.sha256, width: art.width, height: art.height, bytes: art.bytes, artifactId: art.id };
}
const rec = {
  id: `rec_${name}`,
  sourceScanId: scan.id,
  url: scan.url_redacted,
  status: scan.status,
  verdict: scan.verdict,
  repairDemo: scan.repair_demo === 1,
  createdAt: scan.created_at,
  finishedAt: scan.finished_at,
  sandboxId: scan.sandbox_id,
  report,
  events: store.listEvents(scanId).map((e) => ({ stage: e.stage, level: e.level, message: `${e.message}`, data: e.data_json ? JSON.parse(e.data_json) : undefined, ts: e.ts })),
  attempts: store.listAttempts(scanId).map((a) => ({
    n: a.n,
    author: a.author,
    script: a.script,
    sha256: a.script_sha256,
    explanation: a.explanation,
    exitCode: a.exit_code,
    stdout: a.stdout_excerpt ?? "",
    stderr: a.stderr_excerpt ?? "",
    outcome: a.outcome ?? "",
    failedChecks: a.failed_checks_json ? JSON.parse(a.failed_checks_json) : [],
    durationMs: a.duration_ms,
    startedAt: a.started_at,
  })),
  screenshot,
};
await writeFile(join(out, `${name}.json`), JSON.stringify(rec, null, 2));
console.log(`exported ${scanId} -> recorded/${name}.json`);
