// Static hygiene checks on a proposed script before it is uploaded. These are
// not the security boundary (the sandbox and its egress policy are); they
// reject obviously out-of-contract code early and give the model a precise
// reason to fix.

export const MAX_SCRIPT_BYTES = 40_000;

const FORBIDDEN: Array<[RegExp, string]> = [
  [/child_process/, "spawning processes is not allowed (use the kit's launchBrowser)"],
  [/worker_threads/, "worker threads are not allowed"],
  [/from\s+["'](node:)?(net|dgram|tls|http|https|http2|dns)["']/, "raw network modules are not allowed"],
  [/import\(\s*["'](node:)?(net|dgram|tls|http|https|http2|dns|child_process)["']\s*\)/, "dynamic import of network/process modules is not allowed"],
  [/\brequire\s*\(/, "CommonJS require() is not available; use ES module imports"],
  [/task\.json["'`]\s*,/, "the task file is read-only"],
  [/setEgress|egress/i, "network policy is controlled by the trusted controller"],
  [/\.submit\s*\(|requestSubmit\s*\(/, "form submission is forbidden"],
];

export function checkScript(script: string): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) problems.push(`script exceeds ${MAX_SCRIPT_BYTES} bytes`);
  if (!/["']\/opt\/teger\/scout-kit\.mjs["']/.test(script)) problems.push('script must import from "/opt/teger/scout-kit.mjs"');
  if (!/writeResult\s*\(/.test(script)) problems.push("script must call writeResult(...)");
  for (const [re, reason] of FORBIDDEN) if (re.test(script)) problems.push(`static check: ${reason}`);
  return problems;
}

/** Strip a surrounding markdown fence if the model added one. */
export function normalizeScript(script: string): string {
  const m = script.match(/^\s*```(?:js|javascript|mjs)?\s*\n([\s\S]*?)\n```\s*$/);
  return (m ? m[1] : script).trim() + "\n";
}
