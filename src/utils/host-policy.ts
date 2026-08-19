/**
 * Shared URL/host policies for MCP server endpoints and web fetching.
 * `mcp/` (a low layer) and `plugins/` (which depends on mcp) both enforce the
 * same MCP endpoint rule through this module, so the policy never drifts
 * between manifest validation, the settings UI, and the HTTP client.
 */

/** Loopback hosts: "localhost" or an IP literal in a loopback range (127/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    const first = Number.parseInt(lower.split(".")[0] ?? "0", 10);
    return first === 127;
  }
  return lower === "::1" || lower === "[::1]";
}

/**
 * Hosts that are never a legitimate MCP endpoint and are the classic SSRF
 * targets: the unspecified/any addresses, cloud metadata and link-local
 * (169.254/16, fe80::/10), and unique-local (fc00::/7). RFC1918 LAN hosts are
 * intentionally NOT blocked so private MCP deployments keep working — MCP
 * endpoints are user-configured/approved, unlike the model-driven fetch_url.
 */
export function isNonRoutableHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) would otherwise slip past
  // the dotted checks; re-check the embedded IPv4 address.
  const mapped = /^(?:0*:)*ffff:(.+)$/.exec(host);
  if (mapped) {
    const embedded = mappedToIpv4(mapped[1]);
    if (embedded) host = embedded;
  }
  if (host === "" || host === "0.0.0.0" || host === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    if (a === 0) return true;
    if (a === 169 && Number(v4[2]) === 254) return true;
    return false;
  }
  if (/^f[cd][0-9a-f]*:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;
  return false;
}

/**
 * MCP endpoint policy: http(s) only, no user info or fragment; plain http is
 * allowed only for loopback hosts; https must not target non-routable
 * (cloud-metadata / link-local / unique-local / unspecified) hosts.
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

/** Convert the tail of an IPv4-mapped IPv6 address to dotted IPv4. */
function mappedToIpv4(tail: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}
