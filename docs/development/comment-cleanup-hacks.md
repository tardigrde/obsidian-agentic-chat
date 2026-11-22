# Comment cleanup: hack list

Comments that admitted a shortcut were deleted. The implementations are still
there. Each entry is a candidate for a follow-up issue; the "Proof" column names
the check that should go red before the fix.

This is a local list, attached to the cleanup PR. It is not a set of blessed
decisions.

## Source

| # | Where | What is hacky | Why it matters | Fix | Proof |
|---|---|---|---|---|---|
| 1 | `src/agent/tool-call-controller.ts` (`gateSubagentDispatch`) | A subagent dispatch with `ask` policy is auto-approved exactly like `allow`; only the child tools are gated. | A user who chose "ask" for mutating tools is never prompted before a mutating role starts. The source still calls this an open safety question. | Prompt at dispatch when the resolved policy is `ask`, or document and test that dispatch itself is not a mutation. | `test/approval-matrix.test.ts` subagent cases |
| 2 | `src/agent/compaction-runtime.ts` (`serializeConversation` call) | The system-message filter is redundant: `serializeMessage` already returns `undefined` for that role. | Two layers claim the same invariant, so a change in either can hide which one enforces it. | Remove the redundant filter, or make it the only guard and pin it. | `test/compaction-runtime.test.ts` system-role case |
| 3 | `src/agent/approval.ts` (`clearMcpPerToolApprovals`) | The `mcp__<serverId>__` prefix is re-implemented instead of using `localMcpToolName` from `src/mcp/tools.ts`. | A naming change in the MCP layer silently leaves per-tool approvals uncleared. The old comment even pointed at the wrong module. | Import the helper, or move the prefix builder to a shared module below both layers. | Unit test that clears approvals after an MCP id rename |
| 4 | `src/llm/models.ts` | `OpenAICompletionsCompat` is imported and re-exported only for a downstream import that no longer exists. | Dead public surface kept alive by a comment that asserts a false constraint. | Remove the import/re-export after confirming no external importer. | `npm run typecheck` + a grep in `scripts/` |
| 5 | `src/agent/tool-call-controller.ts` (`ToolApprovalRequest.sessionLabel`) | The field is documented as a modal title and is never read. | A future maintainer can wire a label with no rendering path; the stale wording hides that. | Remove the field or render it in the inline card. | Approval card test for a background tab label |
| 6 | `src/agent/modes.ts` (`TOGGLE_MODES`) | The constant is documented as the composer toggle contract, but the composer hardcodes Safe/YOLO; only a test reads the array. | A third mode would update the advertised contract without changing the toggle, or vice versa. | Use the constant in the toggle, or delete it and the test assertion. | `test/modes.test.ts` + a UI toggle test |
| 7 | `src/ui/composer-controller.ts` (drop handling) | Reads Obsidian's undocumented internal `dragManager` through a cast. | An Obsidian internal rename silently breaks multi-file drops; the text/URL fallback handles only one path. | Put the adapter behind a small capability probe with a tested fallback, or use a public drop event. | `test/ui/composer-drop.test.ts` multi-file case |
| 8 | `src/ui/transcript-view.ts` (`lastBubbleError`) | Two error render paths are deduped by comparing the last bubble's error string. | Any message-text change or new error path bypasses the guard and restores the duplicate panel. | Route turn-level errors through one renderer with an explicit event identity. | `test/ui/chat-view-states.test.ts` error-path case |
| 9 | `src/ui/session-list-modal.ts` | A 100 ms timer guesses whether a blur is focus settling or a real commit. | A slow frame can steal focus back or commit a rename early. | Commit from an explicit click/key path; treat blur as cancel or use `focusout` with `relatedTarget`. | `test/ui/session-list-modal.test.ts` slow-frame case |
| 10 | `src/vault/read-memo.ts` (`contentCache`) | A second cache holds file text even though session dedupe may already cover it; the deleted TODO deferred the measurement. | Unproven state and an extra update path; profiling may show it saves nothing. | Measure, then keep with evidence or delete the cache. | A profile or a test showing a measurable win |
| 11 | `src/settings.ts` (`redraw`) | Production branches on `SettingTab.update` because the vitest Obsidian mock lacks it. | A test double shapes production control flow and leaves a branch uncovered. | Extend the mock and remove the guard. | `test/settings.test.ts` redraw case |
| 12 | `src/plugins/loader.ts` (missing `getAbstractFileByPath`) | Returns an empty plugin list when a minimal harness lacks the vault tree API. | A production entry point silently reports no plugins for an incomplete double. | Implement the tree API in the harness and delete the branch. | `test/plugins-loader.test.ts` |
| 13 | `src/plugins/loader.ts` (`resolveMcpServers`) | Keeps a legacy plugin-state fallback for pre-migration/test data. | Two sources for plugin server state can drift. | Make tests build the `mcpState` shape and remove the fallback. | `test/plugins-service.test.ts` migrated shape |
| 14 | `src/settings-mcp-section.ts` | Re-implements the runtime's state-map/legacy-`mcp.servers` resolution. | A second rule can diverge from `resolveMcpServers`. | Share one resolver. | `test/settings-mcp-state.test.ts` parity case |
| 15 | `src/skills/builtin-skills.ts`, `src/tools/skill-tools.ts`, `src/ui/install-plugin-modal.ts` | User/model-facing copy still says "Resources tab"; settings now says Advanced → Agent plugins. | The model is told to point users at a tab that does not exist. | Update the copy and the system prompt; run the canary for the prompt change. | `eval --canary` + a settings e2e label assertion |

## Tests and tooling

| # | Where | What is hacky | Why it matters | Fix | Proof |
|---|---|---|---|---|---|
| 16 | `test/redaction-names.test.ts` | Keeps a hand-maintained copy of `SECRET_KEY_NAMES`. | A new sensitive key can leave the fixture stale, so key and text redactors disagree. | Export the production list or derive the fixture from it. | `test/privacy-redaction.test.ts` |
| 17 | `test/upgrade-fixtures.test.ts` | Hand-replays the order of `loadSettings` steps. | `main.ts` can add or reorder a step while the fixture keeps validating a stale path. | Call the real loader with a fake vault/secret store. | `test/upgrade-fixtures.test.ts` against the real path |
| 18 | `test/e2e/chaos/explorer-driver.ts` | Copies `matchSelectOption` inline into the page script. | The driver and `scripts/chaos/explorer-core.ts` can diverge with no test comparing them. | Inject the shared function source or expose it through a tested hook. | `test/chaos-explorer.test.ts` parity case |
| 19 | `test/e2e/specs/clip.e2e.ts` | Window resizing tolerates failure because WebDriver `setWindowSize` is a no-op under Xvfb/Xephyr. | Geometry assertions can run against a stale size, so a pass does not prove the width. | Use Electron's window API in the driver and fail when it cannot resize. | `test/e2e/specs/clip.e2e.ts` width assertion |
| 20 | `test/e2e/chaos/chaos-monkey.e2e.ts` | A one-click deny is accepted when the approval element disappears. | A regression that silently resolves approvals would also pass. | Read the recorded step-row choice, not the card's absence. | `test/e2e/specs/approval-deterministic.e2e.ts` deny case |
| 21 | `test/helpers/fake-vault.ts` | Move dedupe is defensive for a duplicate key the hide logic says cannot happen. | A fake-vault tree bug is papered over instead of failing. | Throw on the duplicate in the fake and fix the producer. | The fake-vault unit test |
| 22 | `scripts/chaos/opencode-run.ts` | The opencode backend ignores `maxTokens` and `temperature`. | Callers pass a token cap and sampling request that is never enforced; reply length depends only on the prompt. | Pass the options through or reject them explicitly. | `test/chaos-opencode-run.test.ts` |

## Stale copy found but not edited

These are not comments, so the cleanup did not change them. They are here so the
next UI pass does not lose them:

- `test/e2e/dogfood/next-level.dogfood.ts` test name and prompt still say
  "approval modal"; the UI has an inline card. Changing a live prompt changes
  the scenario, so it needs its own review.
- Chaos error messages still say "the write approval modal never appeared".
  They only run on failure; safe to reword.
