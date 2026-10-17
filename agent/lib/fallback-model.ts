import type { LanguageModel } from "ai";

export type ModelObject = Exclude<LanguageModel, string>;

/**
 * Try the primary model; if the request itself fails (rate limit, outage,
 * bad key) use the fallback. Errors after a stream has started are not
 * retried here, and the controller's attempt budget still applies.
 */
export function withFallback(primary: ModelObject, fallback: ModelObject): ModelObject {
  const p = primary as unknown as Record<string, unknown> & {
    doGenerate: (o: unknown) => Promise<unknown>;
    doStream: (o: unknown) => Promise<unknown>;
  };
  const f = fallback as unknown as typeof p;
  return {
    specificationVersion: p.specificationVersion,
    provider: `${String(p.provider)}+fallback`,
    modelId: String(p.modelId),
    supportedUrls: p.supportedUrls,
    async doGenerate(options: unknown) {
      try {
        return await p.doGenerate(options);
      } catch (error) {
        console.warn(`[teger] primary model failed (${(error as Error).message?.slice(0, 160)}); using fallback`);
        return f.doGenerate(options);
      }
    },
    async doStream(options: unknown) {
      try {
        return await p.doStream(options);
      } catch (error) {
        console.warn(`[teger] primary model failed (${(error as Error).message?.slice(0, 160)}); using fallback`);
        return f.doStream(options);
      }
    },
  } as unknown as ModelObject;
}

