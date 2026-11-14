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
| Approval modal opens before a write | `src/ui/approval-modal.ts#ApprovalModal` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Stop closes a pending approval | `src/ui/approval-modal.ts#onOpen` | `test/e2e/specs/approval-deterministic.e2e.ts#closes the approval modal when the user stops the turn` | `covered` |
| Allow applies the change | `src/ui/approval-modal.ts#onOpen` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Deny is two-step and blocks the change | `src/ui/approval-modal.ts#onOpen` | `test/e2e/specs/approval-deterministic.e2e.ts#captures # composer text into standing instructions through approval` | `covered` |
| Diff preview before an edit | `src/ui/approval-modal.ts#onOpen` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Remember a deny for this tool | `src/ui/approval-modal.ts#onOpen` | `test/e2e/specs/approval-deterministic.e2e.ts#keeps don't ask again passive and remembers deny after the final choice` | `covered` |
| Skill tools cannot be remembered | `src/ui/approval-modal.ts#onOpen` | `test/approval-memory.test.ts#never remembers allow for persistent skill tools (injection gate)` (policy only) | `partial` |
| Global mutating gate persists | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` (persistence; behavior also exercised by `approval-deterministic.e2e.ts`) | `covered` |
| Per-tool override through settings | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` | `covered` |
| Per-tool deny flips to allow in a recorded run | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/probe/scenarios/settings-gate.e2e.ts#records a denied write, flips the override, and records the write succeeding` | `covered` |
| Working directories and `/add-dir` are gone | `src/ui/commands.ts#SLASH_COMMANDS` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts#runs an in-pane slash command (/help) without calling the model` | `covered` |
| Safe asks before mutating tools | `src/agent/tool-call-controller.ts#beforeToolCall` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted write and undo removes the created note` | `covered` |
| Safe/YOLO toggle | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/plan-removal.e2e.ts#out of help and the composer` (existence only) | `partial` |
| `/plan` and the Plan badge are gone | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/plan-removal.e2e.ts#out of help and the composer` | `covered` |
| Invalid mode transition is blocked | `src/ui/chat-view.ts#chooseAutocomplete` | `test/modes.test.ts#validateModeTransition` (unit only) | `partial` |
| Background-tab approval badge and label | `src/ui/chat-tabs.ts#syncTabStrip` | `test/e2e/specs/multi-tab-approval.e2e.ts#surfaces background tab approval with tab badge and session label (no auto-switch)` | `covered` |
| Closing a tab clears its pending approval | `src/ui/chat-tabs.ts#switchToTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#clears pending modal and badge when background tab is closed` | `covered` |
| Approval modal at phone width | `src/ui/approval-modal.ts#ApprovalModal` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps approval modals visible and touchable at phone width` | `covered` |

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
