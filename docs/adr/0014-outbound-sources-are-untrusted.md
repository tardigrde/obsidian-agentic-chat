# 0014 — Outbound sources are untrusted, bounded, and re-checked per hop

- Status: Accepted
- Date: 2026-11-22

## Decision

Outbound requests and imported sources share one rule: treat remote content as
untrusted, bound it, and keep the trust decision on our side.

`fetch_url`:

- Parses and allows hosts by suffix allowlist; empty allows only public hosts.
- Follows redirects manually and re-runs the host and allowlist check on every
  hop. `requestUrl`'s auto-follow is best-effort and never the security
  boundary.
- Rejects non-HTTP(S), userinfo, fragments, and private/loopback targets by
  default.
- Caps returned characters and offsets; a short wall page is not mistaken for an
  article.
- Wraps fetched text in escaped tool-output markers and tells the model it is
  data, not instructions. Authorization stays in the tool-call controller.

`web_search` runs one request at a time per provider. Parallel calls to the same
provider queue; a live Brave run drew HTTP 429 from three parallel calls.

Private vault rules take mixed path globs, tags, and frontmatter properties.
Matched paths are invisible to read, list, search, and mutation. Properties are
read from frontmatter and inline tags; nested tags match the parent rule.

PDF import copies the buffer before handing it to pdf.js (the worker may detach
it), uses the app's `loadPdfJs` in Obsidian, and caps extracted text. Document
import never writes through a DOM sink.

Secrets live in Obsidian `secretStorage`. `data.json` stores only secret ids.
The native store caps ids at 64 characters, so long ids are truncated with a
SHA-256 suffix; the suffix distinguishes kinds that share a prefix. Legacy
plaintext is migrated once and deleted.

## Why

Every one of these rules prevents a concrete failure: an SSRF through a redirect
hop, a 429 from parallel search, a private note leaking through a property rule,
a detached buffer producing empty PDF text, a stored key in a vault backup, or a
fetched page instructing the model to call a tool.

A single allowlist check at the first URL is not enough because a redirect can
change the host after the check. A cap on the initial request is not enough
because the extracted article can be larger than the response. The checks have
to sit at the boundary where the bytes are actually handed on.

## Consequences

- `src/tools/web-fetch.ts` owns redirect and content-type handling; a new fetcher
  must reuse it rather than call `requestUrl` directly.
- `src/tools/web-search.ts` owns the per-provider queue.
- `src/vault/private-rules.ts` owns the mixed rule parser; UI and tools must ask
  it, not re-implement a glob check.
- `src/retrieval/pdf-ingest.ts` owns the pdf.js buffer copy and caps.
- `src/secrets/secret-store.ts` owns the id cap and migration. Do not persist a
  secret value, even as an empty string, in settings.

## Links

- `src/tools/web-fetch.ts`
- `src/tools/web-search.ts`
- `src/vault/private-rules.ts`
- `src/retrieval/pdf-ingest.ts`
- `src/retrieval/source-ingest.ts`
- `src/secrets/secret-store.ts`
- `test/web-fetch.test.ts`
- `test/private-rules.test.ts`
