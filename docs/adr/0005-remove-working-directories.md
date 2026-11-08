# 0005 — Remove working directories

- Status: Accepted
- Date: 2026-11-08
- Issue: #101, #273

## Decision

Remove the working-directory approval scope. Delete `/add-dir`, `/dirs`, the
settings section, the composer folder menu entry, the context chips, and the
policy refinement. Approval falls back to Safe/ask, YOLO/allow, and per-tool
rules. Keep vault read/write sandboxing and ignored globs unchanged.

## Why

- Working directories are vault-internal only. External folders cannot resolve
  by design, so the external-scope use case is impossible.
- With dirs configured, reads outside the set ask first, even pathless searches.
  That friction fights the search-read-synthesize workflow.
- The folder-listing half duplicates the agent's own list and search tools.
- Safe, YOLO, per-tool rules, and ignored globs already cover the real
  permission needs.

## Consequences

- Remove the command, settings, chips, and policy surfaces in one change.
- Old `data.json` files that still contain `approval.workingDirs` load and drop
  the key. Sessions and settings keep working.
- Safe still asks for mutating calls, YOLO still allows, and per-tool overrides
  still win. Only the extra working-directory boundary disappears.
- Do not change `ignoredGlobs` or the protected deny-list.

## Links

- #101 (decision)
- #273 (implementation)
- `src/agent/tool-call-controller.ts`
- `src/settings-schema.ts`
