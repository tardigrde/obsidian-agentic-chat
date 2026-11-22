# 0014 — Outbound sources are untrusted, bounded, and re-checked per hop

- Status: Accepted
- Date: 2026-11-22

## Decision

Remote content is untrusted, bounded, and judged on our side at the hop where the bytes are handed on.
`fetch_url` allows hosts by suffix allowlist and follows redirects manually, re-running the host check on
every hop; `requestUrl` auto-follow is never the security boundary. Non-HTTP(S), userinfo, fragments, and
private or loopback targets are rejected by default, and returned text is capped and wrapped in escaped
tool-output markers that mark it as data, not instructions.

`web_search` runs one request per provider at a time; parallel calls queue. Private vault rules match
paths, tags, and properties, and matched content is invisible to read, list, search, and mutation.

## Why

Each rule stops a concrete failure: an SSRF through a redirect hop, a 429 from parallel search, a private
note leaking through a property rule, or a page instructing the model to call a tool. A check only at the
first URL misses a redirect that changes the host; a response limit misses a larger extracted article.

## Consequences

- `src/tools/web-fetch.ts` owns redirect and content-type handling; a new fetcher reuses it.
- `src/tools/web-search.ts` owns the per-provider queue; `src/vault/private-rules.ts` owns the parser.
- `src/secrets/secret-store.ts` owns the id cap. Never persist a secret value, even as an empty string.

## Links

- `src/tools/web-fetch.ts`
- `src/vault/private-rules.ts`
- `src/secrets/secret-store.ts`
