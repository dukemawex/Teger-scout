import { randomBytes } from "node:crypto";

function int(name: string, fallback: number) {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
      apiKey: process.env.CREATEOS_SANDBOX_API_KEY ?? "",
      baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL ?? "https://api-eu.sb.createos.sh",
      shape: process.env.TEGER_SANDBOX_SHAPE ?? "s-1vcpu-1gb",
      rootfs: process.env.TEGER_SANDBOX_ROOTFS ?? "desktop:1",
    },
    eve: {
      host: process.env.EVE_HOST ?? "http://127.0.0.1:3101",
      password: process.env.EVE_INTERNAL_PASSWORD ?? "",
    },
    model: {
      provider: process.env.TEGER_MODEL_PROVIDER ?? "anthropic",
      id: process.env.TEGER_MODEL_ID ?? "",
      configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.TEGER_MODEL_API_KEY || process.env.AI_GATEWAY_API_KEY),
    },
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
    // Live scans create billable sandboxes, so they require an access code.
    liveAccessCode: process.env.TEGER_LIVE_ACCESS_CODE ?? "",
    pilotDomains: (process.env.TEGER_PILOT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    sessionSecret: process.env.TEGER_SESSION_SECRET ?? randomBytes(32).toString("hex"),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function liveExecutionAvailable(cfg: AppConfig) {
  return Boolean(cfg.createos.apiKey && cfg.eve.password && cfg.model.configured);
}
