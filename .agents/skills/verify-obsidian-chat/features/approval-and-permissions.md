# Approval and permissions

## Sub-features

- Approval modal for a mutating tool call: Allow, Deny, an optional reason, and
  "Don't ask again for this tool".
- Diff, rename, delete, and skill-body previews.
- Global mutating policy: ask, allow, deny.
- Per-tool overrides.
- Working directories: auto-run inside, ask outside.
- Modes: Safe and YOLO.
- In-chat mode toggle, `/dirs`, `/add-dir`.
- Background-tab approval with a tab badge and a session label.
- The approval modal cannot remember the persistent skill tools
  (`create_skill`, `load_skill`, `unload_skill`).

## How to get to it (user view)

- A tool that needs approval opens the modal automatically.
- Open Settings and select Agentic Chat, then open the **Agent** tab and find **Approval gates** for
  gates, per-tool overrides, and working directories.
- Composer toolbar: click the Safe/YOLO toggle.
- Type `/dirs` or `/add-dir` in the composer.

## Driving it with the probe harness

```ts
await sendPrompt("scripted write");
const modal = await $(".agentic-chat-approval");
await modal.waitForExist();
await (await modal.$("button=Allow")).click();
```

- Deny is two-step: click `button=Deny`, then `button=Confirm Deny`.
- Remember: toggle **Don't ask again for this tool**, then choose Allow or Deny.
- Settings: use `openAgenticChatSettings()`, `selectSettingsTab("Agent")`,
  `setSettingSelect("Write file", "ask")`.
- Working directory: seed `settings.approval.workingDirs` through
  `browser.executeObsidian`, as `approval-deterministic.e2e.ts` does.
- Background tab: start the turn on tab 1, switch to tab 2 before the approval
  resolves, then assert `.agentic-chat-tab.is-needs-approval`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Approval modal opens before a write | `src/ui/approval-modal.ts:27` | `test/e2e/specs/approval-deterministic.e2e.ts:311` | `covered` |
| Stop closes a pending approval | `src/ui/approval-modal.ts:101` | `test/e2e/specs/approval-deterministic.e2e.ts:527` | `covered` |
| Allow applies the change | `src/ui/approval-modal.ts:127` | `test/e2e/specs/approval-deterministic.e2e.ts:311` | `covered` |
| Deny is two-step and blocks the change | `src/ui/approval-modal.ts:114` | `test/e2e/specs/approval-deterministic.e2e.ts:379` | `covered` |
| Diff preview before an edit | `src/ui/approval-modal.ts:52` | `test/e2e/specs/approval-deterministic.e2e.ts:329` | `covered` |
| Remember a deny for this tool | `src/ui/approval-modal.ts:79` | `test/e2e/specs/approval-deterministic.e2e.ts:437` | `covered` |
| Skill tools cannot be remembered | `src/ui/approval-modal.ts:68` | `test/approval-memory.test.ts:35` (policy only) | `partial` |
| Global mutating gate persists | `src/settings.ts:895` | `test/e2e/specs/settings-ui.e2e.ts:260` (persistence; behavior also exercised by `approval-deterministic.e2e.ts`) | `covered` |
| Per-tool override through settings | `src/settings.ts:895` | `test/e2e/specs/settings-ui.e2e.ts:260` | `covered` |
| Per-tool deny flips to allow in a recorded run | `src/settings.ts:895` | `test/e2e/probe/scenarios/settings-gate.e2e.ts:75` | `covered` |
| Working dir auto-runs inside and asks outside | `src/agent/tool-call-controller.ts:266` | `test/e2e/specs/approval-deterministic.e2e.ts:393` | `covered` |
| Working directories settings row | `src/settings.ts:895` | no committed check | `NONE` |
| Safe/YOLO toggle | `src/ui/chat-view.ts:777` | `test/e2e/specs/plan-removal.e2e.ts:93` (existence only) | `partial` |
| `/plan` and the Plan badge are gone | `src/ui/chat-view.ts:777` | `test/e2e/specs/plan-removal.e2e.ts:93` | `covered` |
| Invalid mode transition is blocked | `src/ui/chat-view.ts:987` | `test/modes.test.ts:63` (unit only) | `partial` |
| `/dirs` lists working directories | `src/ui/chat-view.ts:1708` | `test/e2e/specs/smoke.e2e.ts:92` | `covered` |
| `/add-dir` grants a directory | `src/ui/working-directory-workflow-controller.ts:86` | `test/working-directory-workflow-controller.test.ts:69` (unit only) | `partial` |
| Background-tab approval badge and label | `src/ui/chat-view.ts:537` | `test/e2e/specs/multi-tab-approval.e2e.ts:102` | `covered` |
| Closing a tab clears its pending approval | `src/ui/chat-view.ts:439` | `test/e2e/specs/multi-tab-approval.e2e.ts:167` | `covered` |
| Approval modal at phone width | `src/ui/approval-modal.ts:34` | `test/e2e/specs/mobile-viewport.e2e.ts:435` | `covered` |

## Gotchas

- Deny needs two clicks: the first enables the reason field, the second
  confirms.
- `deny` overrides `allow` at every layer. A per-tool deny overrides the global
  policy, and a remembered choice writes into the same `perTool` map.
- "Don't ask again" is hidden for `create_skill`, `load_skill`, and
  `unload_skill`.
- The plugin refuses mode changes while any tab streams.
- A background approval does not take focus. The tab shows a badge and the modal
  title includes the tab label.
- Closing the tab closes its pending approval modal.
