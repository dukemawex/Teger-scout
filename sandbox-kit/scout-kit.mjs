// scout-kit.mjs: trusted helper that the Teger Scout controller uploads into
// every CreateOS inspection sandbox before generated code runs.
//
// It is convenience and defence in depth, not the security boundary. The
// boundary is the CreateOS egress allowlist (validated IP:port rules applied
// outside the VM by the controller). Generated code may ignore this kit; it
// still cannot reach anything the controller did not authorize.
//
// Zero dependencies. Requires Node 22+ (global WebSocket and fetch).

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const TASK_PATH = process.env.TEGER_TASK_PATH ?? "/opt/teger/task.json";

/** The task the controller authorized. Treat every field as read-only. */
export const task = JSON.parse(await readFile(TASK_PATH, "utf8"));

export const OUT_DIR = task.outDir ?? "/tmp/teger/out";
export const SCREENSHOT_PATH = `${OUT_DIR}/screenshot.png`;
export const RESULT_PATH = `${OUT_DIR}/result.json`;

const MAX_RESULT_BYTES = 300 * 1024;
const MAX_TEXT = 4000;

const allowedHosts = new Set((task.allowedHosts ?? []).map((h) => String(h).toLowerCase()));

function hostAllowed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "about:" || u.protocol === "blob:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return allowedHosts.has(u.hostname.toLowerCase());
}

async function exists(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error("scout-kit: no Chrome/Chromium binary found in sandbox");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Launch headless Chrome with hostname resolution pinned to the IPs the
 * controller validated, then return a Browser with newPage().
 */
export async function launchBrowser() {
  const chrome = await findChrome();
  const port = 9300 + Math.floor(Math.random() * 500);
  const viewport = task.viewport ?? { width: 1280, height: 800 };
  const profile = `/tmp/teger/profile-${process.pid}`;
  await mkdir(profile, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--password-store=basic",
  ];
  if (task.resolverRules) args.push(`--host-resolver-rules=${task.resolverRules}`);
  args.push("about:blank");
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  proc.stderr.on("data", (d) => {
    if (chromeErr.length < 4000) chromeErr += d.toString();
  });

  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch {
      if (proc.exitCode !== null) break;
    }
  }
  if (!wsUrl) throw new Error(`scout-kit: Chrome did not start. ${chromeErr.slice(0, 600)}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("scout-kit: CDP websocket failed")), { once: true });
  });
  const cdp = new CdpConnection(ws);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});

  return {
    newPage: () => createPage(cdp, viewport),
    close: async () => {
      try {
        await cdp.send("Browser.close");
      } catch {
        /* already closed */
      }
      proc.kill("SIGKILL");
    },
  };
}

async function createPage(cdp, viewport) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);

  const chain = [];
  const blocked = [];
  const subresourceHosts = new Map();
  let mainFrameId;
  let mainResponse = null;
  let loadFired = false;

  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    switch (msg.method) {
      case "Fetch.requestPaused": {
        const url = p.request.url;
        const method = p.request.method;
        const isDocument = p.resourceType === "Document";
        let reason = null;
        if (!hostAllowed(url)) reason = "host-not-authorized";
        else if (method !== "GET" && method !== "HEAD") reason = "non-get-request-blocked";
        if (reason) {
          if (blocked.length < 200) blocked.push({ url: url.slice(0, 500), method, resourceType: p.resourceType, reason, isDocument });
          send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        } else {
          send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
        }
        break;
      }
      case "Network.requestWillBeSent": {
        try {
          const h = new URL(p.request.url).hostname;
          if (h) subresourceHosts.set(h, (subresourceHosts.get(h) ?? 0) + 1);
        } catch {
          /* ignore non-URL schemes */
        }
        if (p.type === "Document" && (!mainFrameId || p.frameId === mainFrameId)) {
          if (p.redirectResponse) {
            const last = chain[chain.length - 1];
            if (last && last.url === p.redirectResponse.url) {
              last.status = p.redirectResponse.status;
              last.location = p.request.url;
            } else {
              chain.push({ url: p.redirectResponse.url, status: p.redirectResponse.status, kind: chain.length === 0 ? "initial" : "http", location: p.request.url });
            }
            if (chain.length < 30) chain.push({ url: p.request.url, status: null, kind: "http" });
          } else if (chain.length === 0 || chain[chain.length - 1].url !== p.request.url) {
            chain.push({ url: p.request.url, status: null, kind: chain.length === 0 ? "initial" : "client" });
          }
        }
        break;
      }
      case "Network.responseReceived": {
        if (p.type === "Document" && (!mainFrameId || p.frameId === mainFrameId)) {
          mainResponse = { url: p.response.url, status: p.response.status, mimeType: p.response.mimeType, protocol: p.response.protocol ?? null };
          const last = chain[chain.length - 1];
          if (last && last.url === p.response.url && last.status === null) last.status = p.response.status;
        }
        break;
      }
      case "Page.loadEventFired":
        loadFired = true;
        break;
      default:
        break;
    }
  });

  await send("Page.enable");
  await send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
  // Never let a page open dialogs that block the inspection.
  cdp.on((msg) => {
    if (msg.sessionId === sessionId && msg.method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    }
  });
  const tree = await send("Page.getFrameTree");
  mainFrameId = tree.frameTree.frame.id;

  const page = {
    /** Navigate, wait for the load event (or the timeout), then a short settle period. */
    async goto(url, { timeoutMs = task.limits?.navigationTimeoutMs ?? 15000 } = {}) {
      loadFired = false;
      const nav = await send("Page.navigate", { url });
      const started = Date.now();
      while (!loadFired && Date.now() - started < timeoutMs) await sleep(100);
      // Settle period: scam pages often render their forms late (timers,
      // client-side frameworks). Bounded so slow pages cannot stall the scan.
      const settleMs = task.limits?.settleMs ?? 4000;
      await sleep(Math.max(0, Math.min(settleMs, timeoutMs - (Date.now() - started))));
      return {
        navigationError: nav.errorText ?? null,
        loadEventFired: loadFired,
        finalUrl: await page.evaluate("location.href").catch(() => mainResponse?.url ?? null),
        status: mainResponse?.status ?? null,
      };
    },
    /** Evaluate a function or expression in the page; returns a JSON value. */
    async evaluate(fnOrExpr, ...args) {
      const expression =
        typeof fnOrExpr === "function" ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})` : String(fnOrExpr);
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`page.evaluate failed: ${d.exception?.description ?? d.text}`.slice(0, 1000));
      }
      return r.result.value;
    },
    /** Poll an in-page predicate until it returns truthy. Throws on timeout. */
    async waitFor(fnOrExpr, { timeoutMs = 8000, intervalMs = 200 } = {}) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeoutMs) {
        last = await page.evaluate(fnOrExpr).catch(() => undefined);
        if (last) return last;
        await sleep(intervalMs);
      }
      throw new Error(`page.waitFor timed out after ${timeoutMs}ms`);
    },
    /** Capture a PNG of the viewport to SCREENSHOT_PATH. */
    async screenshot() {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const buf = Buffer.from(data, "base64");
      await writeFile(SCREENSHOT_PATH, buf);
      return { path: SCREENSHOT_PATH, bytes: buf.length };
    },
    redirectChain: () => chain.map((h) => ({ ...h })),
    blockedRequests: () => blocked.map((b) => ({ ...b })),
    contactedHosts: () => [...subresourceHosts.entries()].map(([host, count]) => ({ host, count })),
    mainResponse: () => (mainResponse ? { ...mainResponse } : null),
  };
  lastPage = page;
  return page;
}

let lastPage = null;

/**
 * Evidence captured by the trusted kit itself (not by the generated script):
 * all page text including open shadow roots and hidden text, and a count of
 * password inputs. The controller uses it to verify the script's claims.
 */
async function kitEvidence() {
  if (!lastPage) return null;
  try {
    return await lastPage.evaluate(() => {
      const roots = [document, ...[...document.querySelectorAll("*")].map((el) => el.shadowRoot).filter(Boolean)];
      const text = roots.map((r) => (r === document ? document.documentElement.textContent : r.textContent) || "").join("\n");
      const passwords = roots.reduce((n, r) => n + r.querySelectorAll("input[type=password]").length, 0);
      const forms = roots.reduce((n, r) => n + r.querySelectorAll("form").length, 0);
      return { text: text.replace(/\s+/g, " ").slice(0, 20000), passwordInputs: passwords, forms, title: document.title || null, url: location.href };
    });
  } catch (e) {
    return { error: String(e.message).slice(0, 300) };
  }
}

/** Truncate strings so results stay within contract limits. */
export function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) : value;
}

/** Write the contract result. Must be called exactly once by the script. */
export async function writeResult(result) {
  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify({ contractVersion: 1, ...result, kitEvidence: await kitEvidence() });
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) {
    throw new Error(`scout-kit: result.json exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  await writeFile(RESULT_PATH, json);
  process.stdout.write(`TEGER_RESULT_WRITTEN ${Buffer.byteLength(json)}\n`);
}
