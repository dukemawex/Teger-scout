import { describe, expect, it } from "vitest";
import { assertRestrictive, buildEgressRules, buildResolverRules, EgressPolicyError, verifyEffectivePolicy } from "../server/policy/egress.js";

describe("CreateOS egress semantics", () => {
  it("never treats an empty list, null or wildcard as block-all", () => {
    // On CreateOS these all mean ALLOW ALL, so the controller must refuse them.
    expect(() => assertRestrictive([])).toThrow(EgressPolicyError);
    expect(() => assertRestrictive(null)).toThrow(EgressPolicyError);
    expect(() => assertRestrictive(undefined)).toThrow(EgressPolicyError);
    expect(() => assertRestrictive(["*"])).toThrow(/wildcard/);
    expect(() => assertRestrictive(["*.example.com"])).toThrow(/wildcard/);
    expect(() => assertRestrictive(["0.0.0.0/0"])).toThrow();
    expect(() => assertRestrictive(["10.0.0.0/8"])).toThrow(/CIDR/);
  });

  it("builds least-privilege IP:port rules from validated hosts only", () => {
    const rules = buildEgressRules([{ host: "example.org", ips: ["93.184.215.14"], isIpLiteral: false }]);
    expect(rules).toEqual(["93.184.215.14:443", "93.184.215.14:80"]);
  });

  it("refuses to build a policy with no hosts", () => {
    expect(() => buildEgressRules([])).toThrow(EgressPolicyError);
  });

  it("detects an effective policy that differs from what was applied", () => {
    const applied = ["93.184.215.14:443", "93.184.215.14:80"];
    expect(verifyEffectivePolicy(applied, [...applied].reverse()).ok).toBe(true);
    expect(verifyEffectivePolicy(applied, []).ok).toBe(false);
    expect(verifyEffectivePolicy(applied, ["*"]).ok).toBe(false);
    expect(verifyEffectivePolicy(applied, [...applied, "1.1.1.1:443"]).ok).toBe(false);
  });

  it("pins browser DNS to validated IPs and fails everything else", () => {
    const rules = buildResolverRules([{ host: "example.org", ips: ["93.184.215.14"], isIpLiteral: false }]);
    expect(rules).toBe("MAP example.org 93.184.215.14, MAP * ~NOTFOUND");
  });
});
