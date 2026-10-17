import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Store } from "./store/db.js";
import { resultSchema, validateScreenshot } from "./scan/contract.js";
import { buildReport } from "./scan/report.js";

// Offline fixture mode: for development and for deployments without
// credentials. Nothing here creates a sandbox or calls a model. The evidence
// files under fixtures/offline/ were produced by running the human-written
// reference script (sandbox-kit/reference-inspect.mjs) against the fixture
// pages with a local Chromium. Every event and report is labelled as such.

export function createOfflineRunner(cfg: AppConfig, store: Store, fixtureDir: string) {
  return {
    async run(scanId: string, key: string) {
      const ev = (stage: string, level: "info" | "warn" | "success" | "error", msg: string) => store.appendEvent(scanId, stage, level, msg);
      store.updateScan(scanId, { status: "running" });
      try {
        ev("validate", "warn", "OFFLINE FIXTURE MODE: no CreateOS sandbox is created and no model is called.");
        const raw = JSON.parse(await readFile(join(fixtureDir, `${key}.json`), "utf8"));
        const result = resultSchema.parse(raw.result);
        ev("run", "info", "Loaded recorded fixture evidence (reference script, local Chromium, development machine).");
        const shotPath = join(fixtureDir, `${key}.png`);
        let shot: Buffer | null = null;
        try {
          shot = await readFile(shotPath);
        } catch {
          shot = null;
        }
        const sv = validateScreenshot(shot);
        let screenshot: { ok: boolean; reason?: string; artifactId?: string; width?: number; height?: number } = { ok: false, reason: sv.ok ? undefined : sv.reason };
        if (sv.ok && shot) {
          const dir = join(cfg.artifactDir, scanId);
          await mkdir(dir, { recursive: true });
          const dest = join(dir, "screenshot.png");
          await copyFile(shotPath, dest);
          const art = store.addArtifact({ scan_id: scanId, kind: "screenshot", mime: "image/png", bytes: shot.length, sha256: createHash("sha256").update(shot).digest("hex"), width: sv.info.width, height: sv.info.height, path: dest });
          screenshot = { ok: true, artifactId: art.id, width: sv.info.width, height: sv.info.height };
          ev("collect", "info", "Fixture screenshot loaded from the repository (captured locally, not in CreateOS).");
        }
        const report = buildReport({
          requestedUrl: raw.requestedUrl,
          requestedHost: new URL(raw.requestedUrl).hostname,
          isIpLiteral: false,
          result,
          screenshot,
          blockedDestinations: raw.blockedDestinations ?? [],
          authorizedHosts: [new URL(raw.requestedUrl).hostname],
          egressVerified: false,
          attempts: 0,
          executionMode: "fixture",
        });
        report.coverage.unshift("Offline fixture: evidence recorded locally from a project-controlled test page. Not a live inspection.");
        store.updateScan(scanId, { status: report.status, verdict: report.verdict, report_json: JSON.stringify(report), finished_at: new Date().toISOString() });
        ev("report", "success", `Fixture verdict: ${report.verdict}`);
        ev("cleanup", "info", "Nothing to clean up (no sandbox was created).");
      } catch (e) {
        store.updateScan(scanId, { status: "failed", error: (e as Error).message, finished_at: new Date().toISOString() });
        ev("report", "error", `Fixture could not be loaded: ${(e as Error).message}`);
      }
    },
  };
}
