// Production launcher: runs the eve agent (loopback only) and the Teger Scout
// API in one container. A per-boot random secret protects the eve routes.
// If either process exits, the other is stopped and the container exits so
// the platform restarts it (the API then recovers orphaned sandboxes).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const env = { ...process.env };
env.EVE_INTERNAL_PASSWORD ||= randomBytes(24).toString("base64url");
env.EVE_HOST ||= "http://127.0.0.1:3101";
env.NODE_ENV ||= "production";

const children = [
  spawn("npx", ["eve", "start", "--host", "127.0.0.1", "--port", "3101"], { env, stdio: "inherit" }),
  spawn("node", ["--import", "tsx", "server/index.ts"], { env, stdio: "inherit" }),
];

let exiting = false;
for (const child of children) {
  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    console.error(`[launcher] child exited (code=${code}, signal=${signal}); stopping`);
    for (const c of children) if (c !== child) c.kill("SIGTERM");
    setTimeout(() => process.exit(code ?? 1), 3000);
  });
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    exiting = true;
    for (const c of children) c.kill(sig);
    setTimeout(() => process.exit(0), 3000);
  });
}
