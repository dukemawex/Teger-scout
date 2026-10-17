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
      const compatible = createOpenAICompatible({
        name: "teger-model",
        baseURL: process.env.TEGER_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: process.env.TEGER_MODEL_API_KEY,
        includeUsage: true,
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
