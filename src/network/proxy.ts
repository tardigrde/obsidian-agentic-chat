/**
 * Shared proxy configuration for every plugin-owned egress path (chat/model
 * requests, MCP servers, observability export). Each subsystem persists its own
 * {@link ProxySettings} pair and may inherit the global network proxy when its
 * own is empty — this module owns the shape, normalization, and that fallback.
 */
export interface ProxySettings {
  /** Optional HTTP proxy URL (`http://host:port`). Empty disables the proxy. */
  proxyUrl: string;
  /** Comma-separated hosts/domains that bypass the proxy. */
  noProxy: string;
}

export const DEFAULT_PROXY_SETTINGS: Readonly<ProxySettings> = {
  proxyUrl: "",
  noProxy: "localhost,127.0.0.1,::1",
};

/**
 * Settings-input example. Plain http is the ONLY proxy scheme
 * {@link normalizeProxyUrl} accepts (the tunnel dials the proxy over a plain
 * TCP socket), so the example deliberately shows that scheme.
 */
export const PROXY_URL_EXAMPLE = "http://192.0.2.10:3128"; // NOSONAR: intentional http literal — see docstring above.

/** Normalize a user-entered proxy URL to a canonical http:// URL; anything else collapses to "". */
export function normalizeProxyUrl(input: string | undefined): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Normalize a bypass list: lowercase, split on commas/whitespace, dedupe.
 * An empty or fully-invalid list falls back to the default local bypasses.
 */
export function normalizeNoProxy(input: string | undefined, fallback: string = DEFAULT_PROXY_SETTINGS.noProxy): string {
  if (!input) return fallback;
  const seen = new Set<string>();
  const values = input
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && /^[a-z0-9.*:[\]_-]+$/.test(part))
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return values.length > 0 ? values.join(",") : fallback;
}

/**
 * A subsystem-specific proxy pair wins when it sets its own proxy URL;
 * otherwise the subsystem inherits the global network proxy wholesale.
 */
export function effectiveProxy(override: ProxySettings, base: ProxySettings): ProxySettings {
  return override.proxyUrl ? { proxyUrl: override.proxyUrl, noProxy: override.noProxy } : base;
}
