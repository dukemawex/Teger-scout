import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";
import { openai } from "eve/models/openai";

// The inspection author is a text-only agent: it has no tools and no sandbox
// access. The trusted controller (server/scan/controller.ts) executes whatever
// script it proposes inside CreateOS and owns every limit and acceptance check.
function selectModel() {
  const provider = process.env.TEGER_MODEL_PROVIDER ?? "anthropic";
  const id = process.env.TEGER_MODEL_ID;
  switch (provider) {
    case "anthropic":
      return anthropic(id ?? "claude-sonnet-5");
    case "openai":
      return openai(id);
    case "openai-compatible": {
      // OpenRouter-specific request fields: a server-side fallback list (free
      // models are often rate-limited upstream) and a low reasoning budget so
      // reasoning models spend their tokens on the script, not on thinking.
      const fallbacks = (process.env.TEGER_MODEL_FALLBACKS ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const reasoning = process.env.TEGER_MODEL_REASONING ?? "low";
      const compatible = createOpenAICompatible({
        name: "teger-model",
        baseURL: process.env.TEGER_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1",
        // OPENROUTER_API_API_KEY is provisioned by `stripe projects add openrouter/api`.
        apiKey: process.env.TEGER_MODEL_API_KEY || process.env.OPENROUTER_API_API_KEY,
        includeUsage: true,
        fetch: async (url, init) => {
          if (typeof init?.body === "string" && String(url).includes("openrouter.ai")) {
            const body = JSON.parse(init.body);
            // OpenRouter accepts at most 3 entries in `models`.
            if (fallbacks.length) body.models = [body.model, ...fallbacks.filter((m) => m !== body.model)].slice(0, 3);
            if (reasoning !== "default") body.reasoning = { effort: reasoning };
            init = { ...init, body: JSON.stringify(body) };
          }
          return fetch(url, init);
        },
      });
      return compatible(id ?? "anthropic/claude-sonnet-5");
    }
    case "gateway":
      return id ?? "anthropic/claude-sonnet-5";
    default:
      throw new Error(`Unsupported TEGER_MODEL_PROVIDER: ${provider}`);
  }
}

export default defineAgent({
  model: selectModel(),
  defaultTools: false,
  modelContextWindowTokens: 128_000,
  limits: {
    sessionTimeoutMs: 15 * 60 * 1000,
  },
});
