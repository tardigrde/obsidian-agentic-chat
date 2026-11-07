# 0001 — Keep pi as the agent runtime

- Status: Accepted
- Date: 2026-11-07
- Issue: #182

## Decision

Keep `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` as the agent
runtime. Do not migrate to another framework now.

## Why

The valuable part is `pi-ai`: multi-provider model catalogs, adapters, retries,
prompt caching, thinking-level negotiation, pricing metadata, and stream
normalization across OpenRouter, Ollama, and OpenAI-compatible gateways.

`pi-agent-core` is a thin loop. The product already owns approval gating,
compaction, the loop guard, subagents, session recording, and service wiring.

The alternatives were measured and rejected: opencode v2 fails mobile and CJS
constraints, and `pi-durable` would require rewriting sessions, subagents,
compaction, and the tool surface.

## Consequences

- Revisit the vendor/unhook option only if pi's release cadence becomes painful.
- Keep the pi-ai import allowlist in `esbuild.config.mjs` under review.
- The deferred vendor option is recorded in #182 and the architecture notes.

## Links

- #182
- `docs/development/architecture.md`
