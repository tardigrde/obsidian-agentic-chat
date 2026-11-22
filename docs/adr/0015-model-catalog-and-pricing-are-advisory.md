# 0015 — The model catalog and pricing cache are advisory, versioned, and never a hard dependency

- Status: Accepted
- Date: 2026-11-22

## Decision

The OpenRouter-style catalog is a cache, not a source of truth. A cached entry
is served while a stale entry refreshes in the background. A missing or older
catalog version is treated as stale and refetched; a failed fetch is silent
because pricing and image metadata are nice-to-have, not a reason to block a
turn.

Lookup order is exact model id, then suffix match for OpenAI-compatible ids
(`gpt-4o` finds `openai/gpt-4o`). Every field is optional; an unknown field
means "no claim", never a default that looks authoritative.

The context window is an explicit override first, then the catalog. An unknown
window disables auto-compaction rather than guessing 128k. A model whose catalog
entry says it accepts image input is offered image attachments; the image flag
comes from `architecture.input_modalities`, with a known-family heuristic only
for releases whose payload omitted the field.

Local inference is free. Pricing metadata still comes from the catalog so cost
readouts are consistent, but the provider path supplies zero rates.

## Why

A catalog fetch can fail on a plane, behind a proxy, or during an OpenRouter
outage. Making it a hard dependency turns a metadata problem into a chat
outage. Serving stale data keeps the model picker and cost readout usable while
the refresh happens.

Guessing a context window is worse than admitting it is unknown: a wrong guess
either disables a useful compaction or lets a request overflow. Suffix matching
is needed because OpenAI-compatible gateways expose bare ids while the catalog
stores namespaced ones.

## Consequences

- `src/llm/pricing-cache.ts` owns versioning, stale-while-refresh, and lookup.
- `src/llm/models.ts` owns the turn model and privacy routing; an unknown window
  disables auto-compaction.
- `src/llm/model-catalog.ts` normalizes the payload and the image flag.
- A new metadata field must be optional in the type and absent when unknown; do
  not invent a fallback value that looks measured.
- The catalog file is versioned and upgrade-tested by
  `test/pricing-cache-upgrade.test.ts`.

## Links

- `src/llm/pricing-cache.ts`
- `src/llm/model-catalog.ts`
- `src/llm/models.ts`
- `test/pricing-cache-upgrade.test.ts`
- `test/model-catalog.test.ts`
