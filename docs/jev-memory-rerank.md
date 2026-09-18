# Jev memory rerank (opt-in)

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev):
`state + questions → typed decisions`, 70–500ms, no string generation.

## What it does

`search_memory` today ranks by lexical hand-weights only. When enabled, a
single parallel `choice` call re-orders the top candidates (default tool
maxResults 8 fits Jev cardinality) before formatting. Fail-soft to lexical
order on disable/keyless/egress-unacknowledged/timeout/malformed.

## Enable (all three required)

1. `settings.jev.rerank.enabled = true`
2. `settings.jev.rerank.allowEgress = true` — query + top candidate texts
   (secret-patterns + high-entropy redacted, 400/500-char truncated) leave
   the device to `api.typesafe.ai`.
3. TypeSafe API key in secretStorage (same slot pattern as all secrets).

`includeVaultScope` (default false): vault-scoped memories keep lexical
order and never leave the device; only `global` memories rerank.

## Budgets

One call per `search_memory` max; memoized per query+ids (60s TTL, 200
entries); ~1k input tokens/call worst case; serial +300ms default timeout.

## Overlap note

Sibling PR #159 (injection guard) adds `injectionGuard` to the same
`jev` settings block with byte-identical apiKey slot + client. Rebase the
second-landing PR additively (see NOTE in `healJevSettings`).

## Files

- `src/agent/jev-client.ts` — shared client (identical copy).
- `src/memory/jev-rerank.ts` — reranker + memo.
- `src/tools/memory-tools.ts` — `search_memory` wiring (`details.jevReranked`).
- `src/agent/runtime-resources.ts` — passes settings through.
