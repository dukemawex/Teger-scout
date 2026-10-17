import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../server/config.js";
import { InspectionSandbox } from "../../server/sandbox/createos.js";
import { buildEgressRules } from "../../server/policy/egress.js";
import { authorizeHost } from "../../server/policy/url.js";

// OPT-IN REAL INTEGRATION TEST. Runs only with TEGER_LIVE_TEST=1 and real
// CreateOS credentials (CREATEOS_SANDBOX_API_KEY, CREATEOS_SANDBOX_BASE_URL).
// It creates one real sandbox, verifies the egress policy and that direct
// outbound connections are actually blocked, runs the kit's reference script
// against TEGER_LIVE_TARGET, and destroys the sandbox.
const enabled = process.env.TEGER_LIVE_TEST === "1" && !!process.env.CREATEOS_SANDBOX_API_KEY;

describe.skipIf(!enabled)("live CreateOS integration", () => {
  it(
    "enforces egress, captures a real screenshot, and cleans up",
    async () => {
      const cfg = loadConfig();
      const target = new URL(process.env.TEGER_LIVE_TARGET ?? "https://example.com/");
      const host = await authorizeHost(target.hostname);
      const rules = buildEgressRules([host]);
      const sb = await InspectionSandbox.create(cfg, `teger-livetest-${Date.now()}`, rules);
      try {
        const verify = await sb.verifyEgress(rules);
        expect(verify.ok).toBe(true);
        const probe = await sb.probeBypass(host.ips);
        expect(probe.blocked).toBe(true);
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
        expect(run.exitCode, run.stderr).toBe(0);
        const png = await sb.download("/tmp/teger/out/screenshot.png", 7 * 1024 * 1024);
        expect(png?.subarray(1, 4).toString()).toBe("PNG");
      } finally {
        await sb.destroy();
      }
    },
    240_000,
  );
});
