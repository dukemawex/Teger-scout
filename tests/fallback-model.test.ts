import { describe, expect, it } from "vitest";
import { withFallback, type ModelObject } from "../agent/lib/fallback-model.js";

const model = (name: string, fail: boolean) =>
  ({
    specificationVersion: "v4",
    provider: name,
    modelId: `${name}-model`,
    supportedUrls: {},
    doGenerate: async () => {
      if (fail) throw new Error(`${name} 429`);
      return { from: name };
    },
    doStream: async () => {
      if (fail) throw new Error(`${name} 503`);
      return { from: name };
    },
  }) as unknown as ModelObject;

describe("model fallback", () => {
  it("uses the primary model when it works", async () => {
    const m = withFallback(model("gemini", false), model("openrouter", false)) as unknown as { doGenerate: (o: unknown) => Promise<{ from: string }>; provider: string };
    expect((await m.doGenerate({})).from).toBe("gemini");
    expect(m.provider).toBe("gemini+fallback");
  });
  it("falls back when the primary request fails (rate limit, outage)", async () => {
    const m = withFallback(model("gemini", true), model("openrouter", false)) as unknown as { doGenerate: (o: unknown) => Promise<{ from: string }>; doStream: (o: unknown) => Promise<{ from: string }> };
    expect((await m.doGenerate({})).from).toBe("openrouter");
    expect((await m.doStream({})).from).toBe("openrouter");
  });
});
