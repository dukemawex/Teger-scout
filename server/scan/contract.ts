import { z } from "zod";

// The structured output contract the generated inspection script must satisfy.
// Everything here came from code running next to an untrusted page, so it is
// bounded and validated before the controller uses any of it.

const str = (max: number) => z.string().max(max);
const strList = (maxItems: number, maxLen = 300) => z.array(z.string().max(maxLen)).max(maxItems);

export const hopSchema = z.object({
  url: str(2048),
  status: z.number().int().min(0).max(999).nullable(),
  kind: z.enum(["initial", "http", "client"]),
  location: str(2048).optional(),
});

export const formSchema = z.object({
  action: str(2048).nullable(),
  method: str(16),
  hasPasswordField: z.boolean(),
  inputTypes: strList(60, 40),
  inputNames: strList(60, 120),
  crossOriginAction: z.boolean(),
});

export const resultSchema = z.object({
  contractVersion: z.literal(1),
  requestedUrl: str(2048),
  finalUrl: str(2048).nullable(),
  httpStatus: z.number().int().min(0).max(999).nullable(),
  redirectChain: z.array(hopSchema).max(30),
  title: str(500).nullable(),
  claimedIdentity: z.object({
    siteName: str(200).nullable(),
    brandMentions: strList(10, 120),
    evidence: strList(10, 300),
  }),
  forms: z.array(formSchema).max(30),
  loginFormDetected: z.boolean(),
  textSignals: z.object({
    urgencyPhrases: strList(10),
    credentialRequests: strList(10),
    instructionsToAI: strList(10, 500),
  }),
  visibleTextSample: str(5000),
  externalScriptOrigins: strList(20, 300),
  blockedRequests: z
    .array(
      z.object({
        url: str(600),
        method: str(16),
        resourceType: str(40).optional(),
        reason: str(80),
        isDocument: z.boolean().optional(),
      }),
    )
    .max(200),
  contactedHosts: z.array(z.object({ host: str(300), count: z.number().int().min(0) })).max(200),
  screenshot: z.object({ path: str(300), bytes: z.number().int().min(0) }).nullable(),
  screenshotError: str(1000).nullable(),
  extractionErrors: strList(20, 1000),
  notes: strList(20, 500),
});

export type InspectionResult = z.infer<typeof resultSchema>;

export const SCREENSHOT_LIMITS = {
  minBytes: 1024,
  maxBytes: 6 * 1024 * 1024,
  minDim: 200,
  maxDim: 4096,
};

export interface PngInfo {
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse a PNG header without decoding pixels. Returns null if not a PNG. */
export function readPngInfo(buf: Buffer): PngInfo | null {
  if (buf.length < 33) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Is the image a single flat colour? (cheap check on raw bytes is unreliable, so only size-based heuristics here) */
export function validateScreenshot(buf: Buffer | null): { ok: true; info: PngInfo } | { ok: false; reason: string } {
  if (!buf) return { ok: false, reason: "screenshot file missing" };
  if (buf.length < SCREENSHOT_LIMITS.minBytes) return { ok: false, reason: `screenshot too small (${buf.length} bytes)` };
  if (buf.length > SCREENSHOT_LIMITS.maxBytes) return { ok: false, reason: `screenshot too large (${buf.length} bytes)` };
  const info = readPngInfo(buf);
  if (!info) return { ok: false, reason: "screenshot is not a valid PNG" };
  const { minDim, maxDim } = SCREENSHOT_LIMITS;
  if (info.width < minDim || info.height < minDim || info.width > maxDim || info.height > maxDim) {
    return { ok: false, reason: `screenshot dimensions out of range (${info.width}x${info.height})` };
  }
  return { ok: true, info };
}
