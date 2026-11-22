# 0015 — The model catalog and pricing cache are advisory, versioned, and never a hard dependency

- Status: Accepted
- Date: 2026-11-22

## Decision

The OpenRouter-style catalog is a cache, not a source of truth. Serve a cached entry while a stale one
refreshes; a missing or older version is stale and is refetched. A failed fetch is silent and blocks no
turn.

Lookup is exact model id, then suffix match for OpenAI-compatible ids. Every field is optional; an
unknown field means "no claim", never an authoritative-looking default. The context window is an explicit
override first, then the catalog; an unknown window disables auto-compaction rather than guessing 128k.
Local inference is free: zero rates from the provider path, catalog pricing for the readout.

## Why

A catalog fetch can fail on a plane, behind a proxy, or during an outage; a hard dependency turns a
metadata problem into a chat outage. Guessing a window is worse than admitting it is unknown.

## Consequences

- `src/llm/pricing-cache.ts` owns versioning, stale-while-refresh, and lookup.
- `src/llm/model-catalog.ts` normalizes the payload and the image flag.
- `src/llm/models.ts` owns the turn model and privacy routing.
- A new field is optional and absent when unknown; never invent a measured-looking fallback.

## Links

- `src/llm/pricing-cache.ts`
- `src/llm/model-catalog.ts`
- `test/pricing-cache-upgrade.test.ts`
