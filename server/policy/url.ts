import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { classifyIp } from "./ip.js";

export const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".onion", ".test", ".invalid", ".example", ".intranet", ".corp", ".localdomain"];

export type UrlRejectCode =
  | "invalid_url"
  | "too_long"
  | "unsupported_scheme"
  | "embedded_credentials"
  | "blocked_host"
  | "blocked_port"
  | "blocked_address"
  | "dns_failure"
  | "not_in_pilot";

export class UrlPolicyError extends Error {
  constructor(
    public code: UrlRejectCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedTarget {
  url: URL;
  href: string;
  host: string;
  port: number;
  isIpLiteral: boolean;
}

/** Syntactic checks only. No network access. */
export function parseTarget(input: string): ParsedTarget {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new UrlPolicyError("invalid_url", "Enter a link to inspect.");
  if (trimmed.length > MAX_URL_LENGTH) throw new UrlPolicyError("too_long", "That link is too long to inspect safely.");
  // Bare domains are common in pasted text; assume https.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UrlPolicyError("invalid_url", "That does not look like a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError("unsupported_scheme", "Only http and https links can be inspected.");
  }
  if (url.username || url.password) {
    throw new UrlPolicyError("embedded_credentials", "Links with embedded usernames or passwords are refused. This is a common phishing trick.");
  }
  // WHATWG URL already canonicalises alternate IPv4 encodings (0x7f.1, 2130706433, 0177.0.0.1)
  // into dotted-quad form, so the checks below see the real address.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UrlPolicyError("invalid_url", "That link has no host.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new UrlPolicyError("blocked_port", "Only standard web ports (80 and 443) are inspected.");
  }
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const isIpLiteral = isIP(bare) !== 0;
  if (isIpLiteral) {
    const verdict = classifyIp(bare);
    if (!verdict.ok) throw new UrlPolicyError("blocked_address", `Blocked destination: ${verdict.reason}.`);
  } else {
    if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new UrlPolicyError("blocked_host", "Blocked destination: local or internal hostname.");
    }
    if (!host.includes(".")) throw new UrlPolicyError("blocked_host", "Blocked destination: single-label hostname.");
    if (!/^[a-z0-9.-]+$/.test(host)) throw new UrlPolicyError("invalid_url", "Hostname contains unsupported characters.");
  }
  url.hash = "";
  return { url, href: url.href, host: bare, port, isIpLiteral };
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export interface AuthorizedHost {
  host: string;
  /** Validated IPv4 addresses the sandbox may connect to for this host. */
  ips: string[];
  isIpLiteral: boolean;
}

export interface PolicyOptions {
  resolver?: Resolver;
  /** Optional pilot allowlist of registrable domains. Empty means any public host. */
  pilotDomains?: string[];
}

function inPilot(host: string, pilotDomains: string[]): boolean {
  return pilotDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Resolve a host and decide whether the sandbox may reach it. Every resolved
 * address must be public; a single private answer blocks the host (defeats
 * mixed-answer rebinding). Only IPv4 is authorised because egress rules and
 * Chrome resolver pinning are expressed as IPv4 literals.
 */
export async function authorizeHost(host: string, opts: PolicyOptions = {}): Promise<AuthorizedHost> {
  const pilot = opts.pilotDomains ?? [];
  if (isIP(host) !== 0) {
    const v = classifyIp(host);
    if (!v.ok) throw new UrlPolicyError("blocked_address", `Blocked destination: ${v.reason}.`);
    if (v.family === 6) throw new UrlPolicyError("blocked_address", "IPv6 literal destinations are not supported in this pilot.");
    if (pilot.length) throw new UrlPolicyError("not_in_pilot", "Raw IP destinations are outside the pilot domain list.");
    return { host, ips: [host], isIpLiteral: true };
  }
  if (pilot.length && !inPilot(host, pilot)) {
    throw new UrlPolicyError("not_in_pilot", "This pilot only inspects links on its approved domain list.");
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolver ?? systemResolver)(host);
  } catch {
    throw new UrlPolicyError("dns_failure", "That hostname could not be resolved.");
  }
  if (addresses.length === 0) throw new UrlPolicyError("dns_failure", "That hostname has no addresses.");
  const v4: string[] = [];
  for (const a of addresses) {
    const v = classifyIp(a);
    if (!v.ok) throw new UrlPolicyError("blocked_address", `Blocked destination: ${host} resolves to a ${v.reason}.`);
    if (v.family === 4) v4.push(a);
  }
  if (v4.length === 0) throw new UrlPolicyError("blocked_address", "IPv6-only hosts are not supported in this pilot.");
  return { host, ips: [...new Set(v4)].slice(0, 8), isIpLiteral: false };
}

export async function authorizeUrl(input: string, opts: PolicyOptions = {}) {
  const parsed = parseTarget(input);
  const authorized = await authorizeHost(parsed.host, opts);
  return { parsed, authorized };
}

const SENSITIVE_PARAM = /(token|key|secret|pass|pwd|auth|session|sid|code|otp|email|mail|sig|jwt|access|cred|ticket|nonce|phone|user|login|account|card|ssn)/i;

/** Redact query values that look sensitive, for ordinary (non-technical) views. */
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const opaque = v.length >= 20 && /^[A-Za-z0-9+/=_.-]+$/.test(v);
    params.append(k, SENSITIVE_PARAM.test(k) || opaque || v.includes("@") ? "[redacted]" : v);
  }
  u.search = params.toString() ? `?${params.toString()}` : "";
  return u.href.replace(/%5Bredacted%5D/g, "[redacted]");
}
