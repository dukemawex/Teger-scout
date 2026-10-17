// Captures desktop and mobile screenshots of the home page and an offline
// fixture report, and fails if the browser logs console errors.
// Usage: node scripts/ui-shots.mjs <baseUrl> <outDir> [fixtureIndex]
import { chromium } from "playwright";

const [base, out, idx = "3"] = process.argv.slice(2);
const browser = await chromium.launch();
const errors = [];
for (const [name, viewport] of [
  ["desktop", { width: 1366, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base);
  await page.waitForSelector(".fixture");
  await page.screenshot({ path: `${out}/home-${name}.png`, fullPage: true });
  await page.click(`.fixture:nth-child(${idx}) .ghost`);
  await page.waitForSelector(".verdict-card", { timeout: 15000 });
  await page.waitForSelector(".preview-frame img, .preview-frame.unavailable");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/scan-${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ consoleErrors: errors }));
if (errors.length) process.exit(1);
