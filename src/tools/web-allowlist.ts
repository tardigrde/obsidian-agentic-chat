/**
 * Web fetch allowlist — pure helpers with no Obsidian runtime dependency.
 * Keeps settings-schema pure (no `obsidian` import via web-fetch).
 */

/**
 * Normalize a user-entered allowlist to a canonical comma-separated list.
 * Empty or fully-invalid input collapses to "" (allow all public).
 * Invalid host patterns are silently filtered; caller may surface a warning.
 */
export function normalizeAllowedHosts(input: string | undefined): string {
  if (!input) return "";
  const seen = new Set<string>();
  const values = input
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && /^[a-z0-9.*-]+$/.test(part))
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return values.join(",");
}

/**
 * Label-boundary aware allowlist check. Each pattern is matched case-insensitively:
 * - `*` allows any host
 * - `*.example.com` allows any host ending in `.example.com` (subdomains only)
 * - `.example.com` allows any host ending in `.example.com`
 * - `example.com` allows `example.com` and any label under it (`sub.example.com`), but not `evil-example.com`
 * Empty allowlist allows all.
 * Port-qualified patterns (e.g. `example.com:8080`) are not supported — they are filtered by normalizeAllowedHosts and never match.
 */
export function isHostAllowedByAllowlist(hostname: string, allowlist: string): boolean {
  if (!allowlist || !allowlist.trim()) return true;
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const patterns = allowlist.split(/[,\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host.endsWith(suffix)) return true;
      continue;
    }
    if (pattern.startsWith(".")) {
      if (host.endsWith(pattern)) return true;
      continue;
    }
    // Bare host: exact or subdomain with label boundary
    if (host === pattern || host.endsWith("." + pattern)) return true;
  }
  return false;
}
