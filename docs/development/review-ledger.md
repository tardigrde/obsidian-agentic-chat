# Review ledger

One row per finding that changed a merge decision. Keep resolved rows; do not
delete the history. The reviewer adds a row when a finding blocks, and the author
adds the resolution and target when it is fixed or deferred.

Status values: `open`, `fixed`, `deferred`, `rejected`.

## 2026-11-06, state-machine and proof batch

| Area | Finding | Status | Resolution or target |
|---|---|---|---|
| Semantic | In-place `index.json` write can truncate the last complete index | `deferred` | Structural semantic ownership PR |
| Semantic | Cross-window lease is in-memory; separate windows are not covered | `deferred` | Structural semantic ownership PR |
| Semantic | Closing the view orphans a running index | `deferred` | Structural semantic ownership PR |
| Compaction | Manual `/compact` audit `start` can land in a new session during a swap | `deferred` | Structural turn/compaction ownership PR |
| Compaction | `/compact` instructions are ignored when it joins an auto run | `deferred` | Structural turn/compaction ownership PR |
| Compaction | Recovery loads outside the swap queue | `deferred` | Structural turn/compaction ownership PR |
| Approval | A deny reason equal to `STOPPED_APPROVAL_REASON` triggers the stop path | `deferred` | Structural turn/compaction ownership PR |
| Plugins | Concurrent install sweeps are not single-flight | `deferred` | Structural semantic/plugin ownership PR |
| Tests | Two-tab Stop aborting only the active tab has no e2e | `deferred` | Fault harness follow-up |
| Tests | Approval e2e could leave `.agentic-chat-approval` open and cascade ten click failures | `fixed` | #224 dismisses it in `afterEach`; `beforeEach` asserts closed |
| Release | semantic-release could not push its version bump to protected `main` | `fixed` | Ruleset plus repo-scoped deploy key; #223 wires the workflow |
| Feature map | Unit-only tests were marked `covered` | `fixed` | #221 requires e2e, probe, or replay proof |
| Feature map | 18 source refs pointed at blank lines; command anchors were wrong | `fixed` | #221 fixes the refs and adds the checker |
| Witness | Loader, timeout, skip, and no-count reds could pass as witnesses | `fixed` | #220 requires a failed-test count and rejects loader output |
| MCP OAuth | A rejected refresh flight was reused | `fixed` | #222 adds a retry witness |
| Agent turn | User Stop did not prove a queued follow-up was cleared | `fixed` | #222 adds the witness |
| Session swap | Duplicate-load test asserted the wrong counter | `fixed` | #222 asserts one load |

## How to add a row

1. Copy the reviewer's finding, not the fix.
2. Name the user-visible or data-loss impact.
3. Use the PR that fixed it, or the structural PR that will.
4. If rejected, say why in one sentence.
