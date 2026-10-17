import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/db.js";
import { PUBLIC_DEMO_OWNER } from "./app.js";

// Recorded evidence: sanitized exports of real live CreateOS scans of the
// project's own fixture pages (scripts/export-recorded.ts). They are loaded as
// read-only public demo scans and labelled "recorded" in the interface.

interface RecordedScan {
  id: string;
  url: string;
  status: string;
  verdict: string;
  repairDemo: boolean;
  createdAt: string;
  finishedAt: string;
  report: unknown;
  events: Array<{ stage: string; level: "info" | "warn" | "error" | "success"; message: string; data?: unknown }>;
  attempts: Array<{ n: number; author: "model" | "seeded"; script: string; sha256: string; explanation: string | null; exitCode: number | null; stdout: string; stderr: string; outcome: string; failedChecks: string[]; durationMs: number | null }>;
  screenshot?: { file: string; sha256: string; width: number; height: number; bytes: number; artifactId: string };
}

export async function importRecordedDemos(store: Store, cfg: AppConfig, dir: string) {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of entries) {
    const rec = JSON.parse(await readFile(join(dir, file), "utf8")) as RecordedScan;
    if (store.getScan(rec.id)) continue;
    store.createScan({ id: rec.id, owner: PUBLIC_DEMO_OWNER, mode: "recorded", urlFull: rec.url, urlRedacted: rec.url, repairDemo: rec.repairDemo });
    for (const e of rec.events) store.appendEvent(rec.id, e.stage, e.level, e.message, e.data);
    for (const a of rec.attempts) {
      const id = store.startAttempt(rec.id, a.n, a.author, a.script, a.sha256, a.explanation);
      store.finishAttempt(id, { exit_code: a.exitCode, stdout_excerpt: a.stdout, stderr_excerpt: a.stderr, outcome: a.outcome, failed_checks: a.failedChecks, duration_ms: a.durationMs ?? 0 });
    }
    const report = rec.report as { preview?: { artifactId?: string } };
    if (rec.screenshot) {
      const destDir = join(cfg.artifactDir, rec.id);
      await mkdir(destDir, { recursive: true });
      const dest = join(destDir, "screenshot.png");
      await copyFile(join(dir, rec.screenshot.file), dest);
      const art = store.addArtifact({ scan_id: rec.id, kind: "screenshot", mime: "image/png", bytes: rec.screenshot.bytes, sha256: rec.screenshot.sha256, width: rec.screenshot.width, height: rec.screenshot.height, path: dest });
      if (report.preview) report.preview.artifactId = art.id;
    }
    store.updateScan(rec.id, { status: rec.status as never, verdict: rec.verdict, report_json: JSON.stringify(report), finished_at: rec.finishedAt });
  }
}
