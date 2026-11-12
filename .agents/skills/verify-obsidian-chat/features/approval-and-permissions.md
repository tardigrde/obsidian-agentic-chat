# Approval and permissions

## Sub-features

- Approval modal for a mutating tool call: Allow, Deny, an optional reason, and
  "Don't ask again for this tool".
- Diff, rename, delete, and skill-body previews.
- Global mutating policy: ask, allow, deny.
- Per-tool overrides.
- Modes: Safe and YOLO.
- In-chat mode toggle.
- Background-tab approval with a tab badge and a session label.
- The approval modal cannot remember the persistent skill tools
  (`create_skill`, `load_skill`, `unload_skill`).

## How to get to it (user view)

- A tool that needs approval opens the modal automatically.
- Open Settings and select Agentic Chat, then open the **Agent** tab and find **Approval gates** for
  gates and per-tool overrides.
- Composer toolbar: click the Safe/YOLO toggle.

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
- Background tab: start the turn on tab 1, switch to tab 2 before the approval
  resolves, then assert `.agentic-chat-tab.is-needs-approval`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Approval modal opens before a write | `src/ui/approval-modal.ts:27` | `test/e2e/specs/approval-deterministic.e2e.ts:314` | `covered` |
| Stop closes a pending approval | `src/ui/approval-modal.ts:100` | `test/e2e/specs/approval-deterministic.e2e.ts:479` | `covered` |
| Allow applies the change | `src/ui/approval-modal.ts:126` | `test/e2e/specs/approval-deterministic.e2e.ts:314` | `covered` |
| Deny is two-step and blocks the change | `src/ui/approval-modal.ts:113` | `test/e2e/specs/approval-deterministic.e2e.ts:382` | `covered` |
| Diff preview before an edit | `src/ui/approval-modal.ts:51` | `test/e2e/specs/approval-deterministic.e2e.ts:332` | `covered` |
| Remember a deny for this tool | `src/ui/approval-modal.ts:78` | `test/e2e/specs/approval-deterministic.e2e.ts:440` | `covered` |
| Skill tools cannot be remembered | `src/ui/approval-modal.ts:67` | `test/approval-memory.test.ts:35` (policy only) | `partial` |
| Global mutating gate persists | `src/settings.ts:902` | `test/e2e/specs/settings-ui.e2e.ts:261` (persistence; behavior also exercised by `approval-deterministic.e2e.ts`) | `covered` |
| Per-tool override through settings | `src/settings.ts:902` | `test/e2e/specs/settings-ui.e2e.ts:261` | `covered` |
| Per-tool deny flips to allow in a recorded run | `src/settings.ts:902` | `test/e2e/probe/scenarios/settings-gate.e2e.ts:75` | `covered` |
| Working directories and `/add-dir` are gone | `src/ui/commands.ts:24` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts:51` | `covered` |
| Safe asks before mutating tools | `src/agent/tool-call-controller.ts:255` | `test/e2e/specs/approval-deterministic.e2e.ts:303` | `covered` |
| Safe/YOLO toggle | `src/ui/chat-view.ts:783` | `test/e2e/specs/plan-removal.e2e.ts:93` (existence only) | `partial` |
| `/plan` and the Plan badge are gone | `src/ui/chat-view.ts:783` | `test/e2e/specs/plan-removal.e2e.ts:93` | `covered` |
| Invalid mode transition is blocked | `src/ui/chat-view.ts:996` | `test/modes.test.ts:63` (unit only) | `partial` |
| Background-tab approval badge and label | `src/ui/chat-view.ts:543` | `test/e2e/specs/multi-tab-approval.e2e.ts:102` | `covered` |
| Closing a tab clears its pending approval | `src/ui/chat-view.ts:445` | `test/e2e/specs/multi-tab-approval.e2e.ts:167` | `covered` |
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
