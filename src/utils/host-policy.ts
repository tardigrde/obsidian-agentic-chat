/**
 * Shared URL/host policies for every outbound request the plugin validates:
 * MCP endpoints, MCP OAuth resource metadata, the model-driven `fetch_url`
 * tool, and local embedding endpoints.
 *
 * Every policy reads a hostname through `canonicalHost`, so the IPv6 bracket
 * form `URL.hostname` returns (`[::1]`) and IPv4-mapped IPv6 literals
 * (`::ffff:127.0.0.1`, serialized by the URL parser as `::ffff:7f00:1`) cannot
 * slip past one policy while another catches them.
 */

/**
 * Lower-cased hostname without IPv6 brackets. An IPv4-mapped IPv6 address is
 * unwrapped to its dotted IPv4 form so the IPv4 rules apply to it.
 */
export function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const mapped = /^(?:0*:)*ffff:(.+)$/.exec(host);
  if (!mapped) return host;
  return mappedToIpv4(mapped[1]) ?? host;
}

/** Loopback hosts: "localhost" or an IP literal in a loopback range (127/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (host === "localhost" || host === "::1") return true;
  return ipv4Octets(host)?.[0] === 127;
}

/**
 * Hosts that are never a legitimate MCP endpoint and are the classic SSRF
 * targets: the unspecified/any addresses, cloud metadata and link-local
 * (169.254/16, fe80::/10). RFC1918/ULA private LAN hosts are intentionally NOT
 * blocked so private MCP deployments keep working — MCP endpoints are
 * user-configured/approved, unlike the model-driven fetch_url.
 */
export function isNonRoutableHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (isUnspecifiedHost(host)) return true;
  const v4 = ipv4Octets(host);
  if (v4) return v4[0] === 0 || isLinkLocalIpv4(v4);
  return isLinkLocalIpv6(host);
}

/**
 * Hosts a server-chosen or model-chosen URL must never reach: loopback, any
 * `*.localhost` name, the unspecified addresses, and the private, link-local,
 * and unique-local ranges (0/8, 10/8, 127/8, 169.254/16, 172.16/12,
 * 192.168/16, fc00::/7, fe80::/10). Hostname/literal based only: it cannot
 * stop DNS rebinding.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (isUnspecifiedHost(host) || host === "::1") return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = ipv4Octets(host);
  if (v4) return isPrivateIpv4(v4);
  return isUniqueLocalIpv6(host) || isLinkLocalIpv6(host);
}

/**
 * MCP endpoint policy: http(s) only, no user info or fragment; plain http is
 * allowed only for loopback hosts; https must not target non-routable
 * (cloud-metadata / link-local / unspecified) hosts.
 */
export function mcpUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '"url" must be a valid absolute URL.';
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return '"url" must use http:// or https://.';
  }
  if (parsed.username || parsed.password) return '"url" must not contain user information.';
  if (parsed.hash) return '"url" must not contain a fragment.';
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return 'non-loopback "url" values must use https://.';
  }
  if (parsed.protocol === "https:" && isNonRoutableHost(parsed.hostname)) {
    return '"url" must not point at a link-local, cloud-metadata, or non-routable host.';
  }
  return null;
}

type Ipv4Octets = [number, number, number, number];

function isUnspecifiedHost(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::";
}

/** Parse a dotted-quad IPv4 literal; returns undefined for anything else. */
function ipv4Octets(host: string): Ipv4Octets | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function isLinkLocalIpv4([a, b]: Ipv4Octets): boolean {
  return a === 169 && b === 254;
}

function isPrivateIpv4(octets: Ipv4Octets): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return isLinkLocalIpv4(octets);
}

/** IPv6 unique-local (fc00::/7). */
function isUniqueLocalIpv6(host: string): boolean {
  return /^f[cd][0-9a-f]*:/.test(host);
}

/** IPv6 link-local (fe80::/10). */
function isLinkLocalIpv6(host: string): boolean {
  return /^fe[89ab][0-9a-f]*:/.test(host);
}

/**
 * Convert the tail of an IPv4-mapped IPv6 address to dotted IPv4, accepting both
 * the dotted form (`127.0.0.1`) and the two-hextet form (`7f00:1`) the URL
 * parser normalizes to. Returns undefined when it isn't a recognizable IPv4.
 */
function mappedToIpv4(tail: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}
