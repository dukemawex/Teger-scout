import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { liveExecutionAvailable, loadConfig, missingSetup } from "./config.js";
import { Store } from "./store/db.js";
import { createApp } from "./app.js";
import { ScanController, recoverOrphans, loadKit } from "./scan/controller.js";
import { InspectionSandbox, destroyById } from "./sandbox/createos.js";
import { EveAuthor } from "./agent/author.js";
import { createOfflineRunner } from "./offline.js";
import { importRecordedDemos } from "./recorded.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const log = (m: string) => console.log(`[teger] ${m}`);

const author = new EveAuthor(cfg);
const controller = new ScanController({
  cfg,
  store,
  createSandbox: (name, egress, signal) => InspectionSandbox.create(cfg, name, egress, signal),
  beginAuthor: (signal) => author.begin(signal),
  kitSource: () => loadKit(join(root, "sandbox-kit/scout-kit.mjs")),
  seededDraft: () => readFile(join(root, "sandbox-kit/seeded-draft.mjs"), "utf8"),
});

const running = new Set<string>();
const runner = {
  start(id: string) {
    running.add(id);
    controller
      .run(id)
      .catch((e) => log(`scan ${id} crashed: ${(e as Error).message}`))
      .finally(() => running.delete(id));
  },
  cancel: (id: string) => controller.cancel(id),
  runningCount: () => running.size,
};

// Any HTTP answer (even 401) means the eve process is up. Cached briefly so
// /api/status stays cheap.
let agentCheck: { at: number; ok: boolean } | null = null;
async function agentHealthy() {
  if (agentCheck && Date.now() - agentCheck.at < 10_000) return agentCheck.ok;
  const ok = await fetch(`${cfg.eve.host}/eve/v1/health`, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
  agentCheck = { at: Date.now(), ok };
  return ok;
}

const offline = createOfflineRunner(cfg, store, join(root, "fixtures/offline"));
const app = createApp({ cfg, store, runner, offline, agentHealthy });

const webDist = join(root, "dist/web");
if (existsSync(webDist)) {
  app.use("/assets/*", serveStatic({ root: webDist }));
  app.use("/favicon.svg", serveStatic({ root: webDist }));
  app.get("*", async (c) => c.html(await readFile(join(webDist, "index.html"), "utf8")));
}

if (cfg.createos.apiKey) {
  recoverOrphans(store, (id) => destroyById(cfg, id), log).catch((e) => log(`orphan recovery error: ${(e as Error).message}`));
}
await importRecordedDemos(store, cfg, join(root, "recorded")).catch((e) => log(`recorded demo import failed: ${(e as Error).message}`));

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  log(`listening on :${info.port} (CreateOS ${cfg.createos.baseUrl}, model ${cfg.model.provider}/${cfg.model.id || "default"})`);
  if (liveExecutionAvailable(cfg)) log("live execution configured");
  else log(`live execution NOT configured, offline fixture mode. Missing: ${missingSetup(cfg, true).join("; ")}`);
});
