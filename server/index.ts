import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
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

const offline = createOfflineRunner(cfg, store, join(root, "fixtures/offline"));
const app = createApp({ cfg, store, runner, offline });

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
  log(`listening on :${info.port} (live execution ${cfg.createos.apiKey ? "configured" : "not configured"}, CreateOS ${cfg.createos.baseUrl})`);
});
