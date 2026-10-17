// Opens a deployed Teger Scout in a fresh browser context, opens each recorded
// live run, and captures desktop and mobile screenshots. Fails on console
// errors or any request to an origin other than the app. Creates no sandbox.
// Usage: node scripts/check-recorded.mjs <baseUrl> <outDir>
import { chromium } from "playwright";

const [base, out] = process.argv.slice(2);
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxyServer ? { proxy: { server: proxyServer } } : {});
const errors = [];
const offOrigin = [];
const results = [];
for (const [name, viewport] of [
  ["desktop", { width: 1366, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("request", (r) => new URL(r.url()).origin !== new URL(base).origin && offOrigin.push(r.url()));
  await page.goto(base);
  await page.waitForSelector(".scan-row");
  const rows = await page.$$eval(".scan-row", (els) => els.length);
  for (let i = 0; i < rows; i++) {
    await page.goto(base);
    await page.waitForSelector(".scan-row");
    await page.click(`.scan-list li:nth-child(${i + 1}) .scan-row`);
    await page.waitForSelector(".verdict-card");
    await page.waitForSelector(".preview-frame img");
    await page.waitForFunction(() => [...document.querySelectorAll(".preview-frame img")].every((i) => i.complete && i.naturalWidth > 0));
    const verdict = await page.textContent(".verdict-card .verdict-pill");
    const tag = await page.textContent(".scan-title .mode-tag");
    await page.click(".technical > summary");
    await page.screenshot({ path: `${out}/recorded-${i}-${name}.png`, fullPage: true });
    results.push({ viewport: name, url: page.url(), tag, verdict });
  }
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  results.push({ viewport: name, horizontalOverflow: scrollWidth > viewport.width });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ results, consoleErrors: errors, offOriginRequests: offOrigin }, null, 2));
if (errors.length || offOrigin.length) process.exit(1);
