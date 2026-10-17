import type { AuthorizedHost } from "./url.js";

/**
 * CreateOS egress semantics (docs: Sandbox/REST-API/Egress):
 *   []  / null / ["*"]  => ALLOW ALL outbound traffic.
 *   non-empty list      => deny by default, only listed destinations reachable.
 * This module therefore refuses to ever produce an empty or wildcard policy.
 */
export class EgressPolicyError extends Error {}

export const WILDCARD_RULES = new Set(["*", "*:*", "0.0.0.0/0", "::/0"]);

/** Build least-privilege IP:port rules for the authorised hosts. */
export function buildEgressRules(hosts: AuthorizedHost[]): string[] {
  const rules = new Set<string>();
  for (const h of hosts) {
    for (const ip of h.ips) {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new EgressPolicyError(`refusing non-IPv4 egress rule for ${ip}`);
      rules.add(`${ip}:443`);
      rules.add(`${ip}:80`);
    }
  }
  const list = [...rules].sort();
  assertRestrictive(list);
  return list;
}

/** Throws unless the rule list is non-empty and contains no allow-all entries. */
export function assertRestrictive(rules: string[] | null | undefined): asserts rules is string[] {
  if (!rules || rules.length === 0) {
    throw new EgressPolicyError("empty egress list means ALLOW ALL on CreateOS; refusing");
  }
  for (const r of rules) {
    if (WILDCARD_RULES.has(r.trim()) || r.trim().startsWith("*")) {
      throw new EgressPolicyError(`wildcard egress rule "${r}" is not permitted`);
    }
    if (/\/\d+/.test(r)) throw new EgressPolicyError(`CIDR egress rule "${r}" is not permitted for inspections`);
  }
}

/** Compare the policy read back from CreateOS with what the controller applied. */
export function verifyEffectivePolicy(expected: string[], effective: string[] | null | undefined): { ok: boolean; reason?: string } {
  if (!effective || effective.length === 0) return { ok: false, reason: "effective egress list is empty (allow-all)" };
  try {
    assertRestrictive(effective);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const a = [...expected].sort().join(",");
  const b = [...effective].sort().join(",");
  if (a !== b) return { ok: false, reason: `effective egress differs from applied policy` };
  return { ok: true };
}

/** Chrome --host-resolver-rules pinning each authorised host to its validated IP. */
export function buildResolverRules(hosts: AuthorizedHost[]): string {
  const parts: string[] = [];
  for (const h of hosts) {
    if (h.isIpLiteral) continue;
    parts.push(`MAP ${h.host} ${h.ips[0]}`);
  }
  // Anything else fails to resolve inside the browser.
  parts.push("MAP * ~NOTFOUND");
  return parts.join(", ");
}
