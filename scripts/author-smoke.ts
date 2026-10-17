// Asks the running eve agent for one inspection script and prints it.
// Usage: EVE_INTERNAL_PASSWORD=... tsx scripts/author-smoke.ts
import { loadConfig } from "../server/config.js";
import { EveAuthor } from "../server/agent/author.js";
import { checkScript, normalizeScript } from "../server/agent/script-check.js";

const author = new EveAuthor(loadConfig());
const t0 = Date.now();
const session = await author.begin();
const p = await session.write({ attemptBudget: 3, timeoutSec: 60 });
const script = normalizeScript(p.script);
console.log(`model turn: ${Date.now() - t0} ms, eve session ${session.sessionId}`);
console.log("explanation:", p.explanation);
console.log("static check problems:", JSON.stringify(checkScript(script)));
console.log("----- script -----\n" + script);
process.exit(0);
