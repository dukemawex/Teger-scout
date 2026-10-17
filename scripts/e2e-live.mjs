// End-to-end check of a DEPLOYED Teger Scout in a fresh browser context.
// Runs one live scan of the deployment's own fixture page and waits for the
// report. Usage:
//   TEGER_LIVE_ACCESS_CODE=... node scripts/e2e-live.mjs <baseUrl> <outDir> [fixtureKey] [--repair-demo]
import { chromium } from "playwright";

const [base, out, fixtureKey = "login"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const repairDemo = process.argv.includes("--repair-demo");
const code = process.env.TEGER_LIVE_ACCESS_CODE ?? "";
// Honour an outbound proxy when the test machine requires one.
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxyServer ? { proxy: { server: proxyServer } } : {});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const offOrigin = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin !== new URL(base).origin) offOrigin.push(r.url());
});

await page.goto(base);
await page.waitForSelector(".mode-badge.live", { timeout: 20000 });
const status = await (await page.request.get(`${base}/api/status`)).json();
const fixture = status.fixtures.find((f) => f.key === fixtureKey);
if (!fixture) throw new Error(`fixture ${fixtureKey} not found`);
await page.fill("#url", fixture.url);
if (status.accessCodeRequired) await page.fill('input[type="password"]', code);
if (repairDemo) await page.check('input[type="checkbox"]');
await page.screenshot({ path: `${out}/e2e-home.png`, fullPage: true });
const started = Date.now();
await page.click("button.primary");
await page.waitForURL(/\/scan\//, { timeout: 20000 });
console.log("scan page:", page.url());
await page.waitForSelector(".verdict-card", { timeout: 21 * 60_000 });
await page.waitForSelector(".preview-frame img, .preview-frame.unavailable");
await page.waitForTimeout(1500);
const verdict = await page.textContent(".verdict-card .verdict-pill");
const preview = (await page.$(".preview-frame img")) ? "screenshot shown" : await page.textContent(".preview-frame.unavailable");
await page.click(".technical > summary");
await page.screenshot({ path: `${out}/e2e-scan-desktop.png`, fullPage: true });
const attempts = await page.$$eval(".attempt > summary", (els) => els.map((e) => e.textContent?.trim()));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/e2e-scan-mobile.png`, fullPage: true });
console.log(JSON.stringify({ verdict, preview, attempts, seconds: Math.round((Date.now() - started) / 1000), consoleErrors: errors, offOriginRequests: offOrigin }, null, 2));
await browser.close();
if (errors.length || offOrigin.length) process.exit(1);
