# Decision records

An ADR records a choice that is expensive to reverse or easy to break by
accident. Comments are for local invariants; see
[Code comments](../development/comments.md).

| # | Decision |
|---|---|
| [0001](0001-keep-pi-runtime.md) | Keep pi as the agent runtime |
| [0002](0002-do-not-merge-tools.md) | Do not merge granular tools |
| [0003](0003-remove-plan-mode.md) | Remove plan mode |
| [0004](0004-no-memory-v2.md) | Do not merge memory v2 |
| [0005](0005-remove-working-directories.md) | Remove working directories |
| [0006](0006-consolidate-tools-and-defer-loading.md) | Consolidate tools and defer rarely used ones |
| [0007](0007-comments-are-for-invariants.md) | Comments are for invariants; decisions live in ADRs |
| [0008](0008-approvals-are-inline-and-deny-by-default.md) | Approvals are inline, deny-by-default, and skill writes are never remembered |
| [0009](0009-transcript-order-is-the-contract.md) | Transcript order is the contract, not the DOM |
| [0010](0010-prompt-context-boundaries.md) | Prompt context is escaped, deduped by section, and never includes private notes |
| [0011](0011-one-session-per-tab-and-two-generations.md) | One session per tab, guarded by two generations |
| [0012](0012-runs-are-bounded-by-stop-guard-and-spend.md) | Runs are bounded by Stop, the loop guard, and spend, not a turn cap |
| [0013](0013-plugin-packages-are-data.md) | Plugin packages are data; MCP servers are runtime copies that start disabled |
| [0014](0014-outbound-sources-are-untrusted.md) | Outbound sources are untrusted, bounded, and re-checked per hop |
| [0015](0015-model-catalog-and-pricing-are-advisory.md) | The model catalog and pricing cache are advisory |
