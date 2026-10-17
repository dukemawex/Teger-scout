// SEEDED DRAFT FOR THE REPAIR DEMONSTRATION. NOT WRITTEN BY THE MODEL.
//
// Deliberate, documented defect (see docs/REPAIR_DEMO.md): the script assumes
// the page's login form is present immediately and has id="login". On the
// /fixtures/delayed page the form appears after three seconds inside a
// shadow root, so `document.querySelector("form#login")` is null and reading
// `.action` throws a TypeError. The script also captures the screenshot only
// after extraction, so the failure loses the preview too.
//
// The live agent receives the real stderr and this code, and must repair it.
import { task, launchBrowser, writeResult, SCREENSHOT_PATH } from "/opt/teger/scout-kit.mjs";

const browser = await launchBrowser();
const page = await browser.newPage();
const nav = await page.goto(task.url);

const form = await page.evaluate(() => {
  const f = document.querySelector("form#login");
  return { action: f.action, method: f.method };
});

const shot = await page.screenshot();
await writeResult({
  requestedUrl: task.url,
  finalUrl: nav.finalUrl,
  httpStatus: nav.status,
  redirectChain: page.redirectChain(),
  title: await page.evaluate(() => document.title),
  claimedIdentity: { siteName: null, brandMentions: [], evidence: [] },
  forms: [{ action: form.action, method: form.method, hasPasswordField: true, inputTypes: [], inputNames: [], crossOriginAction: false }],
  loginFormDetected: true,
  textSignals: { urgencyPhrases: [], credentialRequests: [], instructionsToAI: [] },
  visibleTextSample: "",
  externalScriptOrigins: [],
  blockedRequests: page.blockedRequests(),
  contactedHosts: page.contactedHosts(),
  screenshot: { path: SCREENSHOT_PATH, bytes: shot.bytes },
  screenshotError: null,
  extractionErrors: [],
  notes: [],
});
await browser.close();
