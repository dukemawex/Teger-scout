import { randomBytes } from "node:crypto";
import { envKey, KEY_NAMES } from "../agent/lib/env.js";

function int(name: string, fallback: number) {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Identifies the running build in /api/status. */
export const BUILD_ID = "2026-10-18.setup-diagnostics";

export function loadConfig() {
  const dataDir = process.env.TEGER_DATA_DIR ?? "./data";
  return {
    port: int("PORT", 8080),
    publicUrl: process.env.TEGER_PUBLIC_URL ?? "",
    production: process.env.NODE_ENV === "production",
    dataDir,
    dbPath: process.env.TEGER_DB_PATH ?? `${dataDir}/teger.db`,
    artifactDir: `${dataDir}/artifacts`,
    createos: {
      // Stripe Projects provisions CREATEOS_PROJECT_API_KEY; it was verified to
      // authenticate the Sandbox API (whoami) at the EU endpoint.
      apiKey: envKey(KEY_NAMES.createos),
      baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL ?? "https://api-eu.sb.createos.sh",
      shape: process.env.TEGER_SANDBOX_SHAPE ?? "s-1vcpu-1gb",
      rootfs: process.env.TEGER_SANDBOX_ROOTFS ?? "desktop:1",
    },
    eve: {
      host: process.env.EVE_HOST ?? "http://127.0.0.1:3101",
      password: process.env.EVE_INTERNAL_PASSWORD ?? "",
    },
    model: describeModel(),
    limits: {
      maxAttempts: int("TEGER_MAX_ATTEMPTS", 3),
      maxHostExpansions: int("TEGER_MAX_HOST_EXPANSIONS", 3),
      scanDeadlineMs: int("TEGER_SCAN_DEADLINE_MS", 300_000),
      scriptTimeoutSec: int("TEGER_SCRIPT_TIMEOUT_SEC", 60),
      navigationTimeoutMs: int("TEGER_NAV_TIMEOUT_MS", 15_000),
      liveConcurrency: int("TEGER_LIVE_CONCURRENCY", 1),
      dailyLiveScans: int("TEGER_DAILY_LIVE_SCANS", 8),
      perSessionHourlyScans: int("TEGER_SESSION_HOURLY_SCANS", 4),
    },
    // Live scans are open by default. Set TEGER_REQUIRE_ACCESS_CODE=1 together
    // with TEGER_LIVE_ACCESS_CODE to require a code for billable scans.
    liveAccessCode: process.env.TEGER_REQUIRE_ACCESS_CODE === "1" ? (process.env.TEGER_LIVE_ACCESS_CODE ?? "").trim() : "",
    pilotDomains: (process.env.TEGER_PILOT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    sessionSecret: process.env.TEGER_SESSION_SECRET ?? randomBytes(32).toString("hex"),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

/** Mirrors agent/agent.ts so /api/status reports the model actually in use. */
function describeModel() {
  const requested = process.env.TEGER_MODEL_PROVIDER ?? "auto";
  const gemini = Boolean(envKey(KEY_NAMES.gemini));
  const openRouter = Boolean(envKey(KEY_NAMES.openRouter));
  const orModel = process.env.TEGER_OPENROUTER_MODEL_ID || process.env.TEGER_MODEL_ID || "poolside/laguna-s-2.1:free";
  const geminiModel = process.env.TEGER_GEMINI_MODEL_ID || "gemini-flash-latest";
  let provider = requested;
  let id = process.env.TEGER_MODEL_ID ?? "";
  let fallback: string | null = null;
  if (requested === "auto" || requested === "google") {
    if (requested === "google" || gemini) {
      provider = "google";
      id = requested === "google" ? id || geminiModel : geminiModel;
      fallback = openRouter ? `openrouter/${orModel}` : null;
    } else {
      provider = "openai-compatible";
      id = orModel;
    }
  }
  return {
    provider,
    id,
    fallback,
    // JSON-schema output (eve outputSchema) only for providers that support it
    // and have no text-only fallback; text mode (Explanation + one fenced block) otherwise.
    structuredOutput: (process.env.TEGER_MODEL_STRUCTURED ?? (["anthropic", "openai"].includes(provider) ? "1" : "0")) === "1",
    configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || gemini || openRouter || process.env.AI_GATEWAY_API_KEY),
  };
}

export function liveExecutionAvailable(cfg: AppConfig) {
  return Boolean(cfg.createos.apiKey && cfg.eve.password && cfg.model.configured);
}

/**
 * What a deployment still needs before live scans can run, by variable name.
 * Never includes values. `agentReachable` is the result of probing the eve process.
 */
export function missingSetup(cfg: AppConfig, agentReachable: boolean) {
  const missing: string[] = [];
  if (!cfg.createos.apiKey) missing.push(`CreateOS sandbox key: set ${KEY_NAMES.createos[0]}`);
  if (!cfg.model.configured) missing.push(`Model key: set GEMINI_API_KEY (Google AI Studio) or ${KEY_NAMES.openRouter[0]} (OpenRouter)`);
  if (!cfg.eve.password) missing.push("Agent process: start the app with `node scripts/start.mjs` (Dockerfile runtime, or `npm start`)");
  else if (!agentReachable) missing.push(`Agent process is not answering at ${cfg.eve.host}; check the deployment logs`);
  return missing;
}
