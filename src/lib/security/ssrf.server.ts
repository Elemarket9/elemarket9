import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function inCidr4(ip: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}
function privateIpv4(ip: string): boolean {
  const ranges: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
    ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],
    ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4],
  ];
  return ranges.some(([network, prefix]) => inCidr4(ip, network, prefix));
}
function ipv6ToGroups(ip: string): number[] | null {
  let value = ip.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = value.slice(lastColon + 1);
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parse = (parts: string[]) => parts.map((part) => /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : -1);
  const l = parse(left), r = parse(right);
  if ([...l, ...r].some((n) => n < 0)) return null;
  const missing = 8 - l.length - r.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  return halves.length === 2 ? [...l, ...Array(missing).fill(0), ...r] : [...l, ...r];
}
function ipv6Prefix(groups: number[], prefix: number): bigint {
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value >> BigInt(128 - prefix);
}
function privateIpv6(ip: string): boolean {
  const groups = ipv6ToGroups(ip);
  if (!groups) return false;
  const value = groups.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
  const first = groups[0];
  // Unspecified, loopback, unique-local, link-local, multicast.
  if (value === 0n || value === 1n) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8
  // Documentation / benchmarking / deprecated transition ranges.
  if (ipv6Prefix(groups, 32) === 0x20010db8n) return true; // 2001:db8::/32
  if (ipv6Prefix(groups, 96) === 0x0064ff9b0000000000000000n) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    if (privateIpv4(embedded)) return true;
  } // 64:ff9b::/96 NAT64

  if (ipv6Prefix(groups, 48) === 0x200100000002n) return true; // 2001:2::/48
  if (ipv6Prefix(groups, 32) === 0x20010000n) return true; // 2001:0000::/32 (Teredo)
  // 6to4 embeds an IPv4 address in groups 1-2 (after the 2002 prefix); block it when the embedded IPv4 is special.
  if (ipv6Prefix(groups, 16) === 0x2002n) {
    const embedded = `${groups[1] >> 8}.${groups[1] & 255}.${groups[2] >> 8}.${groups[2] & 255}`;
    if (privateIpv4(embedded)) return true;
  }
  // IPv4-compatible and IPv4-mapped IPv6 addresses inherit IPv4 reachability semantics.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    if (privateIpv4(embedded)) return true;
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    if (privateIpv4(embedded)) return true;
  }
  return false;
}
export function isPrivateOrReservedIp(ip: string): boolean {
  const kind = isIP(ip);
  return kind === 4 ? privateIpv4(ip) : kind === 6 ? privateIpv6(ip) : false;
}

/** Validate the endpoint and every DNS result before a server-side fetch. */
export async function assertPublicHttpsEndpoint(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("Endpoint credentials are not allowed");
  if (url.port && url.port !== "443") throw new Error("Non-standard HTTPS ports are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isPrivateOrReservedIp(host)) {
    throw new Error("Endpoint targets a private or reserved network");
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error("Endpoint resolves to a private or reserved network");
  }
  return url;
}
