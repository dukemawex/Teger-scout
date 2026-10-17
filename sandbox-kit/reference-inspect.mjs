// HUMAN-WRITTEN REFERENCE SCRIPT. Used only to test scout-kit locally and to
// record the offline fixture evidence in fixtures/offline/. Live scans never
// use it: their scripts are written by the eve agent at runtime.
import { task, launchBrowser, writeResult, clip, SCREENSHOT_PATH } from "/opt/teger/scout-kit.mjs";

const extractionErrors = [];
const notes = [];
const browser = await launchBrowser();
const page = await browser.newPage();
const nav = await page.goto(task.url);
if (nav.navigationError) notes.push(`navigation: ${nav.navigationError}`);

try {
  await page.waitFor(() => document.readyState === "complete" && document.body && document.body.innerText.trim().length > 0, { timeoutMs: 6000 });
} catch (e) {
  extractionErrors.push(String(e.message));
}
// Give late-rendering content a short, bounded chance to appear.
try {
  await page.waitFor(
    () => {
      const roots = [document, ...[...document.querySelectorAll("*")].map((el) => el.shadowRoot).filter(Boolean)];
      return roots.some((r) => r.querySelector("input[type=password], form"));
    },
    { timeoutMs: 5000 },
  );
} catch {
  notes.push("no form appeared within 5s");
}

let shot = null;
let screenshotError = null;
try {
  shot = await page.screenshot();
} catch (e) {
  screenshotError = String(e.message);
}

let evidence = {};
try {
  evidence = await page.evaluate(() => {
    const roots = [document, ...[...document.querySelectorAll("*")].map((el) => el.shadowRoot).filter(Boolean)];
    const all = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
    const forms = all("form").map((f) => {
      const action = new URL(f.getAttribute("action") || location.href, location.href).href;
      const inputs = [...f.querySelectorAll("input")];
      return {
        action,
        method: (f.getAttribute("method") || "get").toLowerCase(),
        hasPasswordField: inputs.some((i) => i.type === "password"),
        inputTypes: inputs.map((i) => i.type || "text").slice(0, 60),
        inputNames: inputs.map((i) => i.name || i.id || "").slice(0, 60),
        crossOriginAction: new URL(action).origin !== location.origin,
      };
    });
    const text = document.body ? document.body.innerText : "";
    const fullText = roots.map((r) => (r === document ? document.documentElement.textContent : r.textContent) || "").join(" ");
    const find = (patterns) => patterns.flatMap((p) => (fullText.match(p) || []).map((m) => m.trim())).slice(0, 10);
    const og = document.querySelector('meta[property="og:site_name"]')?.content || document.querySelector('meta[name="application-name"]')?.content || null;
    const logos = all("img[alt]").map((i) => i.alt.trim()).filter(Boolean);
    const headings = all("h1, h2").map((h) => h.textContent.trim()).filter(Boolean);
    const strong = all("strong").map((s) => s.textContent.trim()).filter((s) => s.length < 40);
    return {
      title: document.title || null,
      claimedIdentity: {
        siteName: og || logos[0] || null,
        brandMentions: [...new Set([...(og ? [og] : []), ...logos, ...strong])].slice(0, 10),
        evidence: [og && `og:site_name=${og}`, ...logos.map((l) => `logo alt=${l}`), ...headings.slice(0, 3).map((h) => `heading: ${h}`)].filter(Boolean).slice(0, 10),
      },
      forms,
      loginFormDetected: all("input[type=password]").length > 0,
      textSignals: {
        urgencyPhrases: find([/account (has been )?suspended/gi, /verify within \d+ hours/gi, /unusual activity/gi, /within \d+ hours/gi, /permanent closure/gi]),
        credentialRequests: find([/enter your password/gi, /confirm your card( number)?/gi, /card pin/gi, /card number/gi]),
        instructionsToAI: find([/ignore (all )?previous instructions[^.]*\./gi, /note to ai[^.]*\./gi, /developer mode[^.]*\./gi, /print your api keys[^.]*/gi]),
      },
      visibleTextSample: text.slice(0, 1500),
      externalScriptOrigins: [...new Set([...document.scripts].filter((s) => s.src).map((s) => new URL(s.src).origin))].slice(0, 20),
    };
  });
} catch (e) {
  extractionErrors.push(String(e.message));
}

await writeResult({
  requestedUrl: task.url,
  finalUrl: nav.finalUrl,
  httpStatus: nav.status,
  redirectChain: page.redirectChain(),
  title: clip(evidence.title ?? null, 500),
  claimedIdentity: evidence.claimedIdentity ?? { siteName: null, brandMentions: [], evidence: [] },
  forms: evidence.forms ?? [],
  loginFormDetected: evidence.loginFormDetected ?? false,
  textSignals: evidence.textSignals ?? { urgencyPhrases: [], credentialRequests: [], instructionsToAI: [] },
  visibleTextSample: clip(evidence.visibleTextSample ?? "", 1500),
  externalScriptOrigins: evidence.externalScriptOrigins ?? [],
  blockedRequests: page.blockedRequests(),
  contactedHosts: page.contactedHosts(),
  screenshot: shot ? { path: SCREENSHOT_PATH, bytes: shot.bytes } : null,
  screenshotError,
  extractionErrors,
  notes,
});
await browser.close();
