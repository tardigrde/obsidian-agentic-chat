# 0002 — Do not merge granular tools

- Status: Accepted
- Date: 2026-11-07
- Issue: #144

## Decision

Do not merge the vault, artifact, skill, or memory tools into action-enum tools.
Keep the granular tools and their separate approval policies.

The optional `import_pdf` alias may delegate to `import_document` PDF handling,
but it is not required for the simplification round.

## Why

- The token savings from merging small tools are small.
- Action enums turn schema errors into runtime errors, which is worse for weak
  models.
- Approval policies differ: read-only, mutating, plan-allowed, child-grantable.
  One name cannot carry two policies.
- Tool-budget drop rules, subagent allowlists, and audit labels depend on the
  current names.

## Consequences

- Keep the seven default vault tools.
- Keep `remember_memory` and `recall_memory` separate if recall returns.
- Do not add a tool merge as part of the interaction cut.

## Links

- #144
- `docs/reference/vault-tools.md`
