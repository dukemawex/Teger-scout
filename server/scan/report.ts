import type { InspectionResult } from "./contract.js";
import { redactUrl } from "../policy/url.js";

export type Verdict = "High risk" | "Suspicious" | "No obvious warning signs observed" | "Inconclusive";
export type Severity = "high" | "medium" | "low";

export interface WarningSign {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface BlockedDestination {
  url: string;
  reason: string;
}

export interface ReportInput {
  requestedUrl: string;
  requestedHost: string;
  isIpLiteral: boolean;
  result: InspectionResult | null;
  screenshot: { ok: boolean; reason?: string; artifactId?: string; width?: number; height?: number };
  blockedDestinations: BlockedDestination[];
  authorizedHosts: string[];
  egressVerified: boolean;
  attempts: number;
  executionMode: "live" | "fixture" | "recorded";
}

export interface Report {
  verdict: Verdict;
  status: "completed" | "partial" | "failed";
  summary: string;
  recommendation: string;
  originalUrl: string | null;
  finalUrl: string | null;
  redirectChain: Array<{ url: string | null; status: number | null; kind: string }>;
  title: string | null;
  claimedIdentity: { name: string | null; supported: boolean; evidence: string[] } | null;
  loginForms: Array<{ action: string | null; method: string; crossOrigin: boolean; hasPassword: boolean }>;
  warningSigns: WarningSign[];
  blockedDestinations: BlockedDestination[];
  preview: { available: boolean; artifactId?: string; width?: number; height?: number; reason?: string };
  coverage: string[];
  limitations: string[];
  executionMode: "live" | "fixture" | "recorded";
}

const TWO_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "com.ng", "org.ng", "gov.ng", "com.br", "co.jp", "co.in", "com.mx", "com.cn", "com.tr", "com.sg"]);

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

const GENERIC_WORDS = new Set(["sign", "signin", "login", "log", "in", "welcome", "home", "account", "secure", "security", "verify", "verification", "update", "online", "bank", "banking", "portal", "page", "my", "the", "and", "support", "help", "service", "services", "official", "website", "site", "inc", "ltd", "llc", "group", "example", "demo", "test"]);

/** Turn a claimed brand name into comparable tokens (letters/digits only). */
export function brandTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_WORDS.has(t));
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pickClaimedName(r: InspectionResult): string | null {
  const candidates = [r.claimedIdentity.siteName, ...r.claimedIdentity.brandMentions].filter((s): s is string => !!s && s.trim().length > 1);
  for (const c of candidates) if (brandTokens(c).length > 0) return c.trim().slice(0, 80);
  return null;
}

export function buildReport(input: ReportInput): Report {
  const r = input.result;
  const signs: WarningSign[] = [];
  const add = (s: WarningSign) => {
    if (!signs.some((x) => x.id === s.id)) signs.push(s);
  };

  // A navigation stopped by policy leaves Chrome on an internal error page.
  const navigationStopped = !!r?.finalUrl && !/^https?:/i.test(r.finalUrl);
  const finalUrl = navigationStopped ? null : (r?.finalUrl ?? null);
  const finalHost = hostOf(finalUrl) ?? input.requestedHost;
  const finalReg = registrableDomain(finalHost);

  if (input.isIpLiteral) {
    add({ id: "ip-literal", severity: "medium", title: "Link uses a raw IP address", detail: "Legitimate services almost always use a named domain. Raw IP links are common in phishing." });
  }
  if (input.requestedHost.split(".").some((l) => l.startsWith("xn--")) || finalHost.split(".").some((l) => l.startsWith("xn--"))) {
    add({ id: "punycode", severity: "medium", title: "Internationalised (look-alike) domain", detail: "The domain uses punycode, which can imitate familiar names with look-alike characters." });
  }
  for (const b of input.blockedDestinations) {
    add({ id: `blocked-${b.url}`, severity: "high", title: "Tried to send the browser to a blocked destination", detail: `${redactUrl(b.url)}: ${b.reason}` });
  }

  let claimed: Report["claimedIdentity"] = null;
  const loginForms: Report["loginForms"] = [];

  if (r) {
    const chainHosts = new Set(r.redirectChain.map((h) => hostOf(h.url)).filter(Boolean) as string[]);
    if (finalUrl && registrableDomain(input.requestedHost) !== finalReg) {
      add({ id: "cross-domain-redirect", severity: "medium", title: "Link redirects to a different website", detail: `Started at ${registrableDomain(input.requestedHost)} and ended at ${finalReg}.` });
    }
    const hops = r.redirectChain.filter((h) => h.kind !== "initial").length;
    if (hops >= 3) {
      add({ id: "many-redirects", severity: "medium", title: `Long redirect chain (${hops} hops)`, detail: "Chains of redirects are often used to hide the final destination." });
    }
    void chainHosts;

    for (const f of r.forms) {
      if (!f.hasPasswordField) continue;
      loginForms.push({ action: redactUrl(f.action), method: f.method.toUpperCase(), crossOrigin: f.crossOriginAction, hasPassword: true });
      if (f.crossOriginAction) {
        add({ id: "cross-origin-login", severity: "high", title: "Login form sends data to another website", detail: `The password form submits to ${hostOf(f.action) ?? "an unknown host"}, not the site you are viewing.` });
      }
    }
    if (r.loginFormDetected && finalUrl?.startsWith("http:")) {
      add({ id: "login-over-http", severity: "high", title: "Password requested without encryption", detail: "The page asks for a password over plain HTTP." });
    }

    const name = pickClaimedName(r);
    if (name) {
      const tokens = brandTokens(name);
      const regLabel = finalReg.split(".")[0];
      const matches = tokens.some((t) => regLabel.includes(t) || t.includes(regLabel));
      const inSubdomain = tokens.some((t) => finalHost.replace(finalReg, "").includes(t));
      claimed = { name, supported: matches, evidence: r.claimedIdentity.evidence.slice(0, 5) };
      if (!matches && r.loginFormDetected) {
        add({
          id: "brand-mismatch-login",
          severity: "high",
          title: `Claims to be “${name}” but is hosted elsewhere`,
          detail: `The page shows ${name} branding and asks for a password, but the website is ${finalReg}${inSubdomain ? " (the brand appears only in the subdomain, a common trick)" : ""}.`,
        });
      } else if (!matches && inSubdomain) {
        add({ id: "brand-in-subdomain", severity: "medium", title: "Brand name used in subdomain only", detail: `“${name}” appears in the subdomain, but the registered domain is ${finalReg}.` });
      }
    }

    if (r.textSignals.urgencyPhrases.length > 0) {
      add({ id: "urgency", severity: "medium", title: "Pressure or urgency language", detail: `Found: ${r.textSignals.urgencyPhrases.slice(0, 3).map((p) => `“${p.slice(0, 80)}”`).join(", ")}` });
    }
    if (r.textSignals.credentialRequests.length > 0 && r.loginFormDetected) {
      add({ id: "credential-request", severity: "medium", title: "Asks for sensitive details", detail: `Found: ${r.textSignals.credentialRequests.slice(0, 3).map((p) => `“${p.slice(0, 80)}”`).join(", ")}` });
    }
    if (r.textSignals.instructionsToAI.length > 0) {
      add({
        id: "prompt-injection",
        severity: "medium",
        title: "Hidden instructions aimed at AI scanners",
        detail: "The page contains text trying to instruct automated tools. Teger Scout treated it as evidence only; it did not change the inspection or this verdict.",
      });
    }
    if (r.httpStatus !== null && r.httpStatus >= 400) {
      add({ id: "http-error", severity: "low", title: `Server responded with HTTP ${r.httpStatus}`, detail: "The page may be offline, removed or blocking automated visits." });
    }
  }

  const high = signs.filter((s) => s.severity === "high").length;
  const medium = signs.filter((s) => s.severity === "medium").length;
  const haveEvidence = !!r;
  const screenshotOk = input.screenshot.ok;

  let verdict: Verdict;
  let status: Report["status"];
  if (!haveEvidence) {
    status = "failed";
    verdict = high > 0 ? "High risk" : "Inconclusive";
  } else if (!screenshotOk) {
    status = "partial";
    verdict = high > 0 ? "High risk" : "Inconclusive";
  } else {
    status = "completed";
    verdict = high > 0 ? "High risk" : medium > 0 ? "Suspicious" : "No obvious warning signs observed";
  }

  const recommendation = {
    "High risk": "Do not open this link or enter any information. If it claims to be from a company you use, go to that company's website by typing its address yourself.",
    Suspicious: "Be careful. Don't sign in, pay, or download anything through this link. Check with the sender using another channel first.",
    "No obvious warning signs observed": "We did not observe common warning signs, but no inspection can guarantee a website is safe. Only continue if you expected this link.",
    Inconclusive: "We could not complete the inspection. Treat this link with caution until you can verify where it came from.",
  }[verdict];

  const summary =
    verdict === "High risk"
      ? `${high} serious warning sign${high === 1 ? "" : "s"} observed.`
      : verdict === "Suspicious"
        ? `${medium} warning sign${medium === 1 ? "" : "s"} observed.`
        : verdict === "Inconclusive"
          ? !haveEvidence
            ? "The inspection did not produce verified evidence."
            : "The inspection finished without a verified preview."
          : "Nothing alarming observed during a limited, read-only visit.";

  const blockedSub = r ? r.blockedRequests.filter((b) => !b.isDocument).length : 0;
  const coverage =
    input.executionMode === "fixture"
      ? []
      : [
          "Visited the link once in an isolated CreateOS sandbox with a headless browser (read-only, no form submission).",
          `Network access limited to ${input.authorizedHosts.length} validated host${input.authorizedHosts.length === 1 ? "" : "s"}${input.egressVerified ? "; egress policy read back and bypass probe blocked" : ""}.`,
          `Inspection script attempts: ${input.attempts}.`,
        ];
  if (r) coverage.push(`Checked title, branding, ${r.forms.length} form${r.forms.length === 1 ? "" : "s"}, redirect chain and page text signals.`);

  const limitations = [
    "A single visit can miss content shown only to some visitors, devices, or countries.",
    "No interaction was performed (no clicks, no typing), so later steps of a scam are not observed.",
  ];
  if (blockedSub > 0) limitations.push(`${blockedSub} request${blockedSub === 1 ? "" : "s"} to other hosts (images, scripts, trackers) were blocked by policy, so the preview may look incomplete.`);
  if (navigationStopped) limitations.push("The page tried to navigate somewhere the policy does not allow, so the final destination was not loaded.");
  if (!screenshotOk) limitations.push(`Preview unavailable: ${input.screenshot.reason ?? "capture failed"}.`);
  if (r && r.extractionErrors.length > 0) limitations.push(`Some evidence could not be collected (${r.extractionErrors.length} extraction error${r.extractionErrors.length === 1 ? "" : "s"}).`);

  return {
    verdict,
    status,
    summary,
    recommendation,
    originalUrl: redactUrl(input.requestedUrl),
    finalUrl: redactUrl(finalUrl),
    redirectChain: (r?.redirectChain ?? []).map((h) => ({ url: redactUrl(h.url), status: h.status, kind: h.kind })),
    title: r?.title?.slice(0, 200) ?? null,
    claimedIdentity: claimed,
    loginForms,
    warningSigns: signs.sort((a, b) => "hml".indexOf(a.severity[0]) - "hml".indexOf(b.severity[0])),
    blockedDestinations: input.blockedDestinations.map((b) => ({ url: redactUrl(b.url) ?? b.url, reason: b.reason })),
    preview: screenshotOk
      ? { available: true, artifactId: input.screenshot.artifactId, width: input.screenshot.width, height: input.screenshot.height }
      : { available: false, reason: input.screenshot.reason ?? "capture failed" },
    coverage,
    limitations,
    executionMode: input.executionMode,
  };
}
