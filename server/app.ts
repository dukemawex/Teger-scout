import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { BUILD_ID, liveExecutionAvailable, missingSetup } from "./config.js";
import type { ScanRow, Store } from "./store/db.js";
import { parseTarget, redactUrl, UrlPolicyError } from "./policy/url.js";
import { fixtureRoutes, FIXTURE_EXAMPLES } from "./fixtures.js";
import { STAGES } from "./scan/controller.js";

export const PUBLIC_DEMO_OWNER = "public-demo";

export interface ScanRunner {
  start(scanId: string): void;
  cancel(scanId: string): void;
  runningCount(): number;
}

export interface AppDeps {
  cfg: AppConfig;
  store: Store;
  runner: ScanRunner;
  offline: { run(scanId: string, fixtureKey: string): Promise<void> };
  /** Whether the eve agent process answers. Defaults to assuming it does. */
  agentHealthy?: () => Promise<boolean>;
}

type Env = { Variables: { owner: string } };

function sign(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApp({ cfg, store, runner, offline, agentHealthy = async () => true }: AppDeps) {
  const app = new Hono<Env>();
  const setup = async () => {
    const missing = missingSetup(cfg, liveExecutionAvailable(cfg) ? await agentHealthy() : true);
    return { liveAvailable: missing.length === 0, missing };
  };

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    // Stops CDN edges from rewriting responses (e.g. injecting analytics scripts).
    if (!c.res.headers.get("Cache-Control")?.includes("no-transform")) {
      const existing = c.res.headers.get("Cache-Control");
      c.header("Cache-Control", existing ? `${existing}, no-transform` : "no-transform");
    }
    if (!c.req.path.startsWith("/fixtures/") && !c.res.headers.has("Content-Security-Policy")) {
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
  });

  // Anonymous, signed browser session. Scans belong to the session that created them.
  app.use("/api/*", async (c, next) => {
    const raw = getCookie(c, "tsid");
    let owner: string | null = null;
    if (raw) {
      const [id, mac] = raw.split(".");
      if (id && mac && safeEqual(mac, sign(cfg.sessionSecret, id))) owner = id;
    }
    if (!owner) {
      owner = randomBytes(18).toString("base64url");
      setCookie(c, "tsid", `${owner}.${sign(cfg.sessionSecret, owner)}`, {
        httpOnly: true,
        sameSite: "Lax",
        secure: cfg.production,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    c.set("owner", owner);
    await next();
  });

  // Mutating API calls must come from our own pages (CSRF defence on top of SameSite).
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header("x-teger-client") !== "web") return c.json({ error: "missing client header" }, 403);
    }
    await next();
  });

  app.route("/fixtures", fixtureRoutes());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/status", async (c) => {
    const { liveAvailable, missing } = await setup();
    return c.json({
      build: BUILD_ID,
      liveAvailable,
      // Names of what is still needed for live scans (never values).
      missing,
      accessCodeRequired: Boolean(cfg.liveAccessCode),
      createosRegion: (() => {
        try {
          return new URL(cfg.createos.baseUrl).host;
        } catch {
          return null;
        }
      })(),
      sandbox: { rootfs: cfg.createos.rootfs, shape: cfg.createos.shape },
      model: { provider: cfg.model.provider, id: cfg.model.id || "default", fallback: cfg.model.fallback },
      limits: { maxAttempts: cfg.limits.maxAttempts, deadlineSeconds: Math.round(cfg.limits.scanDeadlineMs / 1000) },
      pilotDomains: cfg.pilotDomains,
      stages: STAGES,
      fixtures: FIXTURE_EXAMPLES.map((f) => ({ ...f, url: cfg.publicUrl ? `${cfg.publicUrl.replace(/\/$/, "")}${f.path}` : f.path })),
    });
  });

  app.post("/api/scans", async (c) => {
    const owner = c.get("owner");
    let body: { url?: unknown; mode?: unknown; repairDemo?: unknown; accessCode?: unknown; fixtureKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body." }, 400);
    }
    const mode = body.mode === "fixture" ? "fixture" : "live";

    if (mode === "fixture") {
      const fx = FIXTURE_EXAMPLES.find((f) => f.key === body.fixtureKey);
      if (!fx) return c.json({ error: "Unknown fixture." }, 400);
      const scan = store.createScan({ owner, mode: "fixture", urlFull: fx.path, urlRedacted: fx.path, repairDemo: false });
      void offline.run(scan.id, fx.key);
      return c.json({ id: scan.id }, 202);
    }

    if (typeof body.url !== "string") return c.json({ error: "Enter a link to inspect." }, 400);
    const { liveAvailable, missing } = await setup();
    if (!liveAvailable) {
      return c.json({ error: `Live inspection is not configured on this deployment (${missing.join("; ")}). Try an offline fixture or a recorded demo.`, missing }, 503);
    }
    if (cfg.liveAccessCode) {
      const code = typeof body.accessCode === "string" ? body.accessCode : "";
      if (!safeEqual(code, cfg.liveAccessCode)) {
        return c.json({ error: "Live inspections create billable sandboxes, so they need an access code." }, 401);
      }
    }
    let target;
    try {
      target = parseTarget(body.url);
    } catch (e) {
      if (e instanceof UrlPolicyError) {
        // Still record the refusal so the user sees a report for blocked destinations.
        const scan = store.createScan({ owner, mode: "live", urlFull: body.url.slice(0, 2048), urlRedacted: redactUrl(body.url) ?? "", repairDemo: false });
        runner.start(scan.id);
        return c.json({ id: scan.id }, 202);
      }
      throw e;
    }
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    if (store.countOwnerLiveScansSince(owner, hourAgo) >= cfg.limits.perSessionHourlyScans) {
      return c.json({ error: "Rate limit reached for this browser. Try again later." }, 429);
    }
    if (store.countLiveScansSince(dayAgo) >= cfg.limits.dailyLiveScans) {
      return c.json({ error: "This deployment's daily sandbox budget is used up. Recorded demos are still available." }, 429);
    }
    if (runner.runningCount() >= cfg.limits.liveConcurrency) {
      return c.json({ error: "Another inspection is running (this plan allows one sandbox at a time). Please wait a minute." }, 429);
    }
    const scan = store.createScan({ owner, mode: "live", urlFull: target.href, urlRedacted: redactUrl(target.href) ?? target.host, repairDemo: body.repairDemo === true });
    runner.start(scan.id);
    return c.json({ id: scan.id }, 202);
  });

  const visible = (c: Context<Env>, id: string): ScanRow | null => {
    const scan = store.getScan(id);
    if (!scan) return null;
    if (scan.owner !== c.get("owner") && scan.owner !== PUBLIC_DEMO_OWNER) return null;
    return scan;
  };

  const publicScan = (scan: ScanRow, full: boolean) => ({
    id: scan.id,
    mode: scan.mode,
    url: scan.url_redacted,
    status: scan.status,
    verdict: scan.verdict,
    repairDemo: scan.repair_demo === 1,
    createdAt: scan.created_at,
    finishedAt: scan.finished_at,
    error: scan.error,
    report: full && scan.report_json ? JSON.parse(scan.report_json) : undefined,
    isDemo: scan.owner === PUBLIC_DEMO_OWNER,
  });

  app.get("/api/scans", (c) => c.json({ scans: store.listScans(c.get("owner")).map((s) => publicScan(s, false)) }));
  app.get("/api/demo", (c) => c.json({ scans: store.listScans(PUBLIC_DEMO_OWNER, 50).map((s) => publicScan(s, false)) }));

  app.get("/api/scans/:id", (c) => {
    const scan = visible(c, c.req.param("id"));
    if (!scan) return c.json({ error: "Not found." }, 404);
    return c.json({
      scan: publicScan(scan, true),
      sandboxId: scan.sandbox_id,
      attempts: store.listAttempts(scan.id).map((a) => ({
        n: a.n,
        author: a.author,
        script: a.script,
        sha256: a.script_sha256,
        explanation: a.explanation,
        startedAt: a.started_at,
        finishedAt: a.finished_at,
        exitCode: a.exit_code,
        stdout: a.stdout_excerpt,
        stderr: a.stderr_excerpt,
        outcome: a.outcome,
        failedChecks: a.failed_checks_json ? JSON.parse(a.failed_checks_json) : [],
        durationMs: a.duration_ms,
      })),
      artifacts: store.listArtifacts(scan.id).map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, sha256: a.sha256, width: a.width, height: a.height })),
    });
  });

  app.get("/api/scans/:id/events", (c) => {
    const scan = visible(c, c.req.param("id"));
    if (!scan) return c.json({ error: "Not found." }, 404);
    const after = Number(c.req.query("after") ?? 0) || 0;
    return c.json({ status: scan.status, events: store.listEvents(scan.id, after).map(toEvent) });
  });

  // Server-sent events with Last-Event-ID resume, so a refresh or reconnect replays history.
  app.get("/api/scans/:id/stream", (c) => {
    const id = c.req.param("id");
    const scan = visible(c, id);
    if (!scan) return c.json({ error: "Not found." }, 404);
    let after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const started = Date.now();
      while (!stream.aborted && Date.now() - started < 10 * 60_000) {
        for (const ev of store.listEvents(id, after)) {
          await stream.writeSSE({ id: String(ev.seq), event: "scan-event", data: JSON.stringify(toEvent(ev)) });
          after = ev.seq;
        }
        const s = store.getScan(id);
        if (s && !["queued", "running"].includes(s.status) && s.finished_at) {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ status: s.status }) });
          break;
        }
        await stream.sleep(700);
      }
    });
  });

  app.post("/api/scans/:id/cancel", (c) => {
    const scan = visible(c, c.req.param("id"));
    if (!scan || scan.owner === PUBLIC_DEMO_OWNER) return c.json({ error: "Not found." }, 404);
    runner.cancel(scan.id);
    return c.json({ ok: true });
  });

  app.get("/api/scans/:id/artifacts/:artifactId", async (c) => {
    const scan = visible(c, c.req.param("id"));
    if (!scan) return c.json({ error: "Not found." }, 404);
    const art = store.getArtifact(scan.id, c.req.param("artifactId"));
    if (!art || art.mime !== "image/png") return c.json({ error: "Not found." }, 404);
    const buf = await readFile(art.path);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline; filename=screenshot.png",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return app;
}

function toEvent(ev: { seq: number; ts: string; stage: string; level: string; message: string; data_json: string | null }) {
  return { seq: ev.seq, ts: ev.ts, stage: ev.stage, level: ev.level, message: ev.message, data: ev.data_json ? JSON.parse(ev.data_json) : undefined };
}
