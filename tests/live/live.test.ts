import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../server/config.js";
import { InspectionSandbox } from "../../server/sandbox/createos.js";
import { buildEgressRules } from "../../server/policy/egress.js";
import { authorizeHost } from "../../server/policy/url.js";

// OPT-IN REAL INTEGRATION TEST. Runs only with TEGER_LIVE_TEST=1 and real
// CreateOS credentials (CREATEOS_SANDBOX_API_KEY or the Stripe Projects
// CREATEOS_PROJECT_API_KEY, plus CREATEOS_SANDBOX_BASE_URL).
// It creates one real sandbox, verifies the egress policy and that direct
// outbound connections are actually blocked, runs the kit's reference script
// against TEGER_LIVE_TARGET, and destroys the sandbox.
const enabled = process.env.TEGER_LIVE_TEST === "1" && !!loadConfig().createos.apiKey;

describe.skipIf(!enabled)("live CreateOS integration", () => {
  it(
    "enforces egress, captures a real screenshot, and cleans up",
    async () => {
      const cfg = loadConfig();
      const target = new URL(process.env.TEGER_LIVE_TARGET ?? "https://example.com/");
      const host = await authorizeHost(target.hostname);
      const rules = buildEgressRules([host]);
      const sb = await InspectionSandbox.create(cfg, `teger-lt-${Date.now().toString(36)}`, rules);
      try {
        console.log("[live] sandbox", sb.id, cfg.createos.rootfs, cfg.createos.shape, cfg.createos.baseUrl);
        const verify = await sb.verifyEgress(rules);
        console.log("[live] egress read-back", JSON.stringify(verify));
        expect(verify.ok).toBe(true);
        const probe = await sb.probeBypass(host.ips);
        console.log("[live] bypass probe", JSON.stringify(probe));
        expect(probe.blocked).toBe(true);
        console.log("[live] runtime", JSON.stringify(await sb.runtimeInfo()));
        const kit = await readFile(join(import.meta.dirname, "../../sandbox-kit/scout-kit.mjs"), "utf8");
        await sb.prepare(kit, {
          url: target.href,
          allowedHosts: [host.host],
          resolverRules: `MAP ${host.host} ${host.ips[0]}, MAP * ~NOTFOUND`,
          limits: { navigationTimeoutMs: 15000 },
          viewport: { width: 1280, height: 800 },
          outDir: "/tmp/teger/out",
        });
        const script = await readFile(join(import.meta.dirname, "../../sandbox-kit/reference-inspect.mjs"), "utf8");
        const run = await sb.runScript(script, 60);
        console.log("[live] run", JSON.stringify({ exitCode: run.exitCode, execMs: run.execMs, stdout: run.stdout.slice(0, 300), stderr: run.stderr.slice(0, 1500) }));
        expect(run.exitCode, run.stderr).toBe(0);
        const png = await sb.download("/tmp/teger/out/screenshot.png", 7 * 1024 * 1024);
        expect(png?.subarray(1, 4).toString()).toBe("PNG");
        const result = await sb.download("/tmp/teger/out/result.json", 300 * 1024);
        console.log("[live] result", result?.toString("utf8").slice(0, 600));
        if (png) await import("node:fs/promises").then((fs) => fs.writeFile(process.env.TEGER_LIVE_SHOT ?? "/tmp/teger-live-shot.png", png));
      } finally {
        await sb.destroy();
        console.log("[live] destroyed", sb.id);
      }
    },
    240_000,
  );
});
