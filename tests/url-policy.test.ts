import { describe, expect, it } from "vitest";
import { authorizeHost, authorizeUrl, parseTarget, redactUrl, UrlPolicyError } from "../server/policy/url.js";
import { classifyIp } from "../server/policy/ip.js";

const resolverFor = (map: Record<string, string[]>) => async (host: string) => {
  if (!(host in map)) throw new Error("NXDOMAIN");
  return map[host];
};

async function rejects(input: string, resolver = resolverFor({})) {
  try {
    await authorizeUrl(input, { resolver });
  } catch (e) {
    expect(e).toBeInstanceOf(UrlPolicyError);
    return (e as UrlPolicyError).code;
  }
  throw new Error(`expected ${input} to be rejected`);
}

describe("URL validation", () => {
  it("accepts ordinary public https and http links", async () => {
    const r = await authorizeUrl("https://example.org/path?q=1#frag", { resolver: resolverFor({ "example.org": ["93.184.215.14"] }) });
    expect(r.parsed.href).toBe("https://example.org/path?q=1");
    expect(r.authorized.ips).toEqual(["93.184.215.14"]);
  });

  it("assumes https for bare domains", () => {
    expect(parseTarget("example.org/x").href).toBe("https://example.org/x");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://example.org/", "data:text/html,hi", "gopher://example.org/"])("rejects non-web scheme %s", async (u) => {
    expect(await rejects(u)).toBe("unsupported_scheme");
  });

  it("rejects embedded credentials", async () => {
    expect(await rejects("https://user:pass@example.org/")).toBe("embedded_credentials");
    expect(await rejects("https://paypal.com@evil.example.net/")).toBe("embedded_credentials");
  });

  it("rejects non-standard ports", async () => {
    expect(await rejects("http://example.org:8080/")).toBe("blocked_port");
    expect(await rejects("https://example.org:22/")).toBe("blocked_port");
  });

  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.0.0.1/",
    "http://0/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
  ])("blocks private, loopback, link-local, metadata and reserved address %s", async (u) => {
    expect(await rejects(u)).toBe("blocked_address");
  });

  it.each(["http://localhost/", "http://LOCALHOST./", "http://printer.local/", "http://metadata.google.internal/", "http://router.home.arpa/", "http://intranet/"])("blocks internal hostname %s", async (u) => {
    expect(await rejects(u)).toBe("blocked_host");
  });

  it("blocks hostnames that resolve to private addresses (DNS-based SSRF)", async () => {
    const resolver = resolverFor({ "rebind.example.net": ["127.0.0.1"], "mixed.example.net": ["93.184.215.14", "10.1.2.3"], "meta.example.net": ["169.254.169.254"] });
    expect(await rejects("http://rebind.example.net/", resolver)).toBe("blocked_address");
    expect(await rejects("http://mixed.example.net/", resolver)).toBe("blocked_address");
    expect(await rejects("http://meta.example.net/", resolver)).toBe("blocked_address");
  });

  it("refuses IPv6-only hosts and IPv6 that embeds IPv4", async () => {
    expect(await rejects("http://v6only.example.net/", resolverFor({ "v6only.example.net": ["2606:4700::6810:84e5"] }))).toBe("blocked_address");
    expect(classifyIp("::ffff:8.8.8.8").ok).toBe(false);
  });

  it("reports DNS failures without guessing", async () => {
    expect(await rejects("https://does-not-exist.example.net/")).toBe("dns_failure");
  });

  it("enforces the optional pilot domain list", async () => {
    const resolver = resolverFor({ "a.example.org": ["93.184.215.14"], "evil.example.net": ["93.184.215.14"] });
    await expect(authorizeHost("a.example.org", { resolver, pilotDomains: ["example.org"] })).resolves.toBeTruthy();
    await expect(authorizeHost("evil.example.net", { resolver, pilotDomains: ["example.org"] })).rejects.toMatchObject({ code: "not_in_pilot" });
  });

  it("redacts sensitive query values for ordinary views", () => {
    const out = redactUrl("https://x.example/p?ref=sms&session_token=abc123&email=a@b.c&id=7&blob=QWxhZGRpbjpvcGVuIHNlc2FtZWFiY2RlZg");
    expect(out).toContain("ref=sms");
    expect(out).toContain("id=7");
    expect(out).toContain("session_token=[redacted]");
    expect(out).toContain("email=[redacted]");
    expect(out).toContain("blob=[redacted]");
    expect(out).not.toContain("abc123");
  });
});
