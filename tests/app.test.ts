import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { Store } from "../server/store/db.js";
import { createOfflineRunner } from "../server/offline.js";

function makeApp(env: Record<string, string> = {}) {
  process.env.TEGER_DATA_DIR = mkdtempSync(join(tmpdir(), "teger-app-"));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cfg = loadConfig();
  for (const k of Object.keys(env)) delete process.env[k];
  const store = new Store(":memory:");
  const started: string[] = [];
  const runner = { start: (id: string) => void started.push(id), cancel: () => {}, runningCount: () => 0 };
  const offline = createOfflineRunner(cfg, store, join(import.meta.dirname, "../fixtures/offline"));
  const app = createApp({ cfg, store, runner, offline });
  return { app, store, started };
}

async function session(app: ReturnType<typeof makeApp>["app"]) {
  const res = await app.request("/api/status");
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return cookie;
}

const post = (cookie: string, body: unknown, extra: Record<string, string> = { "x-teger-client": "web" }) => ({
  method: "POST",
  headers: { cookie, "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

describe("API access control", () => {
  it("hides another session's scan and artifacts (404, not 403)", async () => {
    const { app } = makeApp();
    const alice = await session(app);
    const bob = await session(app);
    const created = await app.request("/api/scans", post(alice, { mode: "fixture", fixtureKey: "login" }));
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 100));
    const mine = await app.request(`/api/scans/${id}`, { headers: { cookie: alice } });
    expect(mine.status).toBe(200);
    const detail = (await mine.json()) as { artifacts: Array<{ id: string }> };
    expect(detail.artifacts.length).toBe(1);
    expect((await app.request(`/api/scans/${id}`, { headers: { cookie: bob } })).status).toBe(404);
    expect((await app.request(`/api/scans/${id}/events`, { headers: { cookie: bob } })).status).toBe(404);
    expect((await app.request(`/api/scans/${id}/artifacts/${detail.artifacts[0].id}`, { headers: { cookie: bob } })).status).toBe(404);
    const img = await app.request(`/api/scans/${id}/artifacts/${detail.artifacts[0].id}`, { headers: { cookie: alice } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("rejects forged session cookies by issuing a fresh session", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/scans", { headers: { cookie: "tsid=attacker.forgedsig" } });
    expect(res.headers.get("set-cookie")).toMatch(/^tsid=/);
  });

  it("requires the client header on mutating requests (CSRF)", async () => {
    const { app } = makeApp();
    const c = await session(app);
    const res = await app.request("/api/scans", post(c, { mode: "fixture", fixtureKey: "info" }, {}));
    expect(res.status).toBe(403);
  });

  it("refuses live scans when live execution is not configured", async () => {
    const { app, started } = makeApp();
    const c = await session(app);
    const res = await app.request("/api/scans", post(c, { url: "https://example.org" }));
    expect(res.status).toBe(503);
    expect(started).toHaveLength(0);
  });

  it("requires the access code for cost-incurring live scans", async () => {
    const { app, started } = makeApp({ CREATEOS_SANDBOX_API_KEY: "k", EVE_INTERNAL_PASSWORD: "p", ANTHROPIC_API_KEY: "a", TEGER_LIVE_ACCESS_CODE: "open-sesame" });
    const c = await session(app);
    expect((await app.request("/api/scans", post(c, { url: "https://example.org", accessCode: "wrong" }))).status).toBe(401);
    expect(started).toHaveLength(0);
    expect((await app.request("/api/scans", post(c, { url: "https://example.org", accessCode: "open-sesame" }))).status).toBe(202);
    expect(started).toHaveLength(1);
  });

  it("rate-limits live scans per browser session", async () => {
    const { app, started } = makeApp({ CREATEOS_SANDBOX_API_KEY: "k", EVE_INTERNAL_PASSWORD: "p", ANTHROPIC_API_KEY: "a", TEGER_SESSION_HOURLY_SCANS: "2" });
    const c = await session(app);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.request("/api/scans", post(c, { url: `https://example.org/${i}` }))).status);
    expect(codes).toEqual([202, 202, 429]);
    expect(started).toHaveLength(2);
  });

  it("serves fixture pages with a restrictive CSP and noindex", async () => {
    const { app } = makeApp();
    const res = await app.request("/fixtures/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const redirect = await app.request("/fixtures/blocked-redirect");
    expect(redirect.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("replays stored events after a reconnect (refresh-safe history)", async () => {
    const { app } = makeApp();
    const c = await session(app);
    const { id } = (await (await app.request("/api/scans", post(c, { mode: "fixture", fixtureKey: "info" }))).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 100));
    const all = (await (await app.request(`/api/scans/${id}/events`, { headers: { cookie: c } })).json()) as { events: Array<{ seq: number }> };
    expect(all.events.length).toBeGreaterThan(2);
    const tail = (await (await app.request(`/api/scans/${id}/events?after=2`, { headers: { cookie: c } })).json()) as { events: Array<{ seq: number }> };
    expect(tail.events[0].seq).toBe(3);
  });
});

describe("optional access code", () => {
  it("treats TEGER_LIVE_ACCESS_CODE=off as no code required", async () => {
    const { app, started } = makeApp({ CREATEOS_SANDBOX_API_KEY: "k", EVE_INTERNAL_PASSWORD: "p", TEGER_MODEL_API_KEY: "a", TEGER_LIVE_ACCESS_CODE: "off" });
    const c = await session(app);
    const status = (await (await app.request("/api/status", { headers: { cookie: c } })).json()) as { accessCodeRequired: boolean };
    expect(status.accessCodeRequired).toBe(false);
    expect((await app.request("/api/scans", post(c, { url: "https://example.org" }))).status).toBe(202);
    expect(started).toHaveLength(1);
  });
});
