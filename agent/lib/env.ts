// Environment variable names accepted for each credential, in priority order.
// Shared by the eve agent and the API so both agree on what is configured.
export const KEY_NAMES = {
  createos: ["CREATEOS_SANDBOX_API_KEY", "CREATEOS_API_KEY", "CREATEOS_PROJECT_API_KEY"],
  gemini: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  // Your own OpenRouter key wins over the one provisioned by
  // `stripe projects add openrouter/api` (OPENROUTER_API_API_KEY).
  openRouter: ["TEGER_MODEL_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API_API_KEY"],
} as const;

/** First non-empty value among `names`, trimmed, with pasted surrounding quotes removed. */
export function envKey(names: readonly string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) return value;
  }
  return "";
}
