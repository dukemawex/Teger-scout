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
  // Added by the trusted kit's writeResult, not by the generated script.
  kitEvidence: z
    .union([
      z.object({
        text: str(20000),
        passwordInputs: z.number().int().min(0),
        forms: z.number().int().min(0),
        formList: z.array(formSchema).max(30).optional(),
        title: str(500).nullable(),
        url: str(2048),
      }),
      z.object({ error: str(400) }),
    ])
    .nullable()
    .optional(),
});

/**
 * Reconcile the script's claims with what the trusted kit observed. Text
 * signals must appear verbatim in the kit's page text; login-form detection
 * follows the kit's password-input count. Returns the corrected result and
 * human-readable notes for every correction.
 */
export function reconcileWithKit(r: InspectionResult): { result: InspectionResult; corrections: string[] } {
  const kit = r.kitEvidence && "text" in r.kitEvidence ? r.kitEvidence : null;
  if (!kit) return { result: r, corrections: r.kitEvidence ? ["kit evidence unavailable; script claims could not be verified"] : [] };
  const corrections: string[] = [];
  const haystack = kit.text.toLowerCase();
  const verify = (label: string, phrases: string[]) =>
    phrases.filter((p) => {
      const ok = p.trim().length >= 3 && haystack.includes(p.trim().toLowerCase().replace(/\s+/g, " "));
      if (!ok) corrections.push(`dropped unverified ${label} "${p.slice(0, 80)}" (not found in page text captured by the kit)`);
      return ok;
    });
  const textSignals = {
    urgencyPhrases: verify("urgency phrase", r.textSignals.urgencyPhrases),
    credentialRequests: verify("credential request", r.textSignals.credentialRequests),
    instructionsToAI: verify("AI-directed text", r.textSignals.instructionsToAI),
  };
  // Deterministic patterns over the kit's text, so the verdict does not depend
  // on how thorough the generated extraction code happened to be.
  const scan = (patterns: RegExp[]) => [...new Set(patterns.flatMap((re) => kit.text.match(re) ?? []).map((m) => m.trim().slice(0, 120)))];
  const merge = (verified: string[], found: string[], label: string) => {
    const extra = found.filter((f) => !verified.some((v) => v.toLowerCase() === f.toLowerCase()));
    if (extra.length) corrections.push(`kit text scan added ${extra.length} ${label}`);
    return [...verified, ...extra].slice(0, 10);
  };
  textSignals.urgencyPhrases = merge(textSignals.urgencyPhrases, scan(URGENCY_PATTERNS), "urgency phrase(s)");
  textSignals.credentialRequests = merge(textSignals.credentialRequests, scan(CREDENTIAL_PATTERNS), "credential request(s)");
  textSignals.instructionsToAI = merge(textSignals.instructionsToAI, scan(AI_DIRECTED_PATTERNS), "AI-directed phrase(s)");

  let forms = r.forms;
  if (kit.formList) {
    const key = (f: { action: string | null; hasPasswordField: boolean }) => `${f.action}|${f.hasPasswordField}`;
    const missing = kit.formList.filter((k) => !r.forms.some((f) => key(f) === key(k)));
    if (missing.length) corrections.push(`kit found ${missing.length} form(s) the script did not report (e.g. inside shadow roots)`);
    forms = [...r.forms.filter((f) => kit.formList!.some((k) => key(k) === key(f))), ...kit.formList.filter((k) => !r.forms.some((f) => key(f) === key(k)))].slice(0, 30);
    const phantom = r.forms.length - r.forms.filter((f) => kit.formList!.some((k) => key(k) === key(f))).length;
    if (phantom > 0) corrections.push(`dropped ${phantom} form(s) reported by the script that the kit did not observe`);
  }

  let loginFormDetected = r.loginFormDetected;
  if (kit.passwordInputs > 0 && !loginFormDetected) {
    loginFormDetected = true;
    corrections.push(`kit found ${kit.passwordInputs} password field(s) the script missed`);
  } else if (kit.passwordInputs === 0 && loginFormDetected) {
    loginFormDetected = false;
    corrections.push("script reported a login form but the kit found no password field");
  }
  return { result: { ...r, textSignals, loginFormDetected, forms }, corrections };
}

const URGENCY_PATTERNS = [
  /account (?:has been |is |was )?(?:suspended|locked|disabled|restricted|on hold)/gi,
  /verify (?:your account )?within \d+ ?(?:hours?|days?|minutes?)/gi,
  /(?:pay|respond|act|confirm) within \d+ ?(?:hours?|days?|minutes?)/gi,
  /unusual (?:sign-?in )?activity/gi,
  /permanent(?:ly)? (?:closure|closed|deleted|suspended)/gi,
  /immediate action required/gi,
  /(?:parcel|package|delivery) (?:is )?(?:on hold|held|suspended)/gi,
];
const CREDENTIAL_PATTERNS = [/enter your password/gi, /confirm your (?:card|card number|identity|password)/gi, /card (?:pin|number)/gi, /\bcvv\b/gi, /one-?time (?:code|password)/gi, /social security number/gi, /bank verification number|\bbvn\b/gi];
const AI_DIRECTED_PATTERNS = [/ignore (?:all )?(?:previous|prior) instructions/gi, /note to (?:ai|llm)[^.]{0,80}/gi, /(?:ai|automated) (?:security )?scanners?[^.]{0,60}(?:safe|trusted|verified)/gi, /developer mode/gi, /(?:print|reveal) (?:your )?(?:api keys?|system prompt|secrets?)/gi];

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
