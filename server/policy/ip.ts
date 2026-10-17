import { BlockList, isIP } from "node:net";

// Destinations an inspection sandbox must never reach, whatever DNS says.
// Anything not matched here and inside global unicast space is "public".
// Separate lists: Node's BlockList matches IPv4 lookups against IPv4-mapped
// IPv6 subnets, so a shared list would make ::ffff:0:0/96 block every IPv4.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped (checked separately via embedded v4 too)
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments incl. Teredo 2001::/32
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique local, incl. AWS IMDS fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

for (const [net, prefix] of V4_BLOCKED) blockedV4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKED) blockedV6.addSubnet(net, prefix, "ipv6");

/** Extract an IPv4 address embedded in an IPv4-mapped / compatible / NAT64 IPv6 address. */
export function embeddedIPv4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export type IpVerdict = { ok: true; family: 4 | 6 } | { ok: false; reason: string };

/** Classify a literal IP address. Only globally routable unicast passes. */
export function classifyIp(address: string): IpVerdict {
  const raw = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(raw);
  if (family === 0) return { ok: false, reason: "not an IP address" };
  if (family === 4) {
    if (blockedV4.check(raw, "ipv4")) return { ok: false, reason: `non-public IPv4 range (${raw})` };
    return { ok: true, family: 4 };
  }
  const inner = embeddedIPv4(raw);
  if (inner) return { ok: false, reason: `IPv6 address embedding IPv4 ${inner} is not allowed` };
  if (blockedV6.check(raw, "ipv6")) return { ok: false, reason: `non-public IPv6 range (${raw})` };
  // Global unicast is 2000::/3; everything else is reserved.
  const first = parseInt(raw.split(":")[0] || "0", 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return { ok: false, reason: `IPv6 outside global unicast (${raw})` };
  return { ok: true, family: 6 };
}
