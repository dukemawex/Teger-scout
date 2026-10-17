// Verifies CreateOS Sandbox access against CREATEOS_SANDBOX_BASE_URL and
// reports identity, available shapes and images. With --runtime it creates
// ONE sandbox with a restrictive egress policy, reports the image's Node and
// Chrome, verifies the egress read-back and bypass probe, then destroys it.
// Never prints the API key.
import { createClient } from "@nodeops-createos/sandbox";
import { loadConfig } from "../server/config.js";
import { InspectionSandbox } from "../server/sandbox/createos.js";

const cfg = loadConfig();
const client = createClient({ apiKey: cfg.createos.apiKey, baseUrl: cfg.createos.baseUrl });
console.log("base URL:", client.baseUrl);
const me = await client.whoami();
console.log("whoami:", JSON.stringify(me));
const shapes = await client.listShapes();
console.log("shapes:", shapes.map((s) => `${s.id} (${s.vcpu} vCPU, ${s.mem_mib} MiB)`).join(", "));
const rootfs = await client.listRootfs();
console.log("rootfs:", rootfs.rootfs.join(", "), "| default:", rootfs.default);
const existing = await client.listSandboxes();
console.log("existing sandboxes:", existing.map((s) => `${s.id}:${s.name ?? ""}:${s.status}`).join(", ") || "none");

if (process.argv.includes("--runtime")) {
  // 1.1.1.1:443 is NOT on this list, so the bypass probe must fail to connect.
  const rules = ["93.184.215.14:443", "93.184.215.14:80"];
  const started = Date.now();
  const sb = await InspectionSandbox.create(cfg, `teger-probe-${Date.now().toString(36)}`, rules);
  console.log(`created ${sb.id} in ${Date.now() - started} ms (${cfg.createos.rootfs}, ${cfg.createos.shape})`);
  try {
    console.log("egress verify:", JSON.stringify(await sb.verifyEgress(rules)));
    console.log("bypass probe:", JSON.stringify(await sb.probeBypass(["93.184.215.14"])));
    console.log("runtime:", JSON.stringify(await sb.runtimeInfo()));
  } finally {
    await sb.destroy();
    console.log("destroyed", sb.id);
  }
}
