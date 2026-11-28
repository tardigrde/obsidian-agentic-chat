# Approval and permissions

## Sub-features

- Inline approval card for a mutating tool call, in the transcript below the
  turn's activity line: Allow, Always allow <tool>, and Deny (two-step, with an
  optional reason). Enter allows, Esc starts the deny. The ApprovalModal is gone.
- Diff, rename, delete, and skill-body previews.
- Global mutating policy: ask, allow, deny.
- Per-tool overrides.
- Modes: Safe and YOLO.
- In-chat mode toggle.
- Background-tab approval: the card waits in its tab, the tab gets the orange
  needs-you dot and "needs approval" in its aria-label, and a notice fires.
- The card has no "Always" for the persistent skill writer (`create_skill`).

## How to get to it (user view)

- A tool that needs approval shows the card in the turn automatically. It takes
  focus unless the composer has text. The composer's Stop resolves it as stopped.
- Open Settings and select Agentic Chat, then open the **Agent** tab and find **Approval gates** for
  gates and per-tool overrides.
- Composer toolbar: click the Safe/YOLO toggle.

## Driving it with the probe harness

```ts
await sendPrompt("scripted write");
await allowApproval(); // test/e2e/support/chat.ts
```

- Pending card: `PENDING_APPROVAL` (`[data-ac="approval"]:not(.is-resolved)`).
  A resolved card stays as a one-line record with `data-ac-state` =
  `allowed|always|denied|stopped`.
- Deny is two-step: `[data-ac="approval-deny"]`, then the same button reads
  "Confirm deny". `denyApproval()` and `alwaysAllowApproval()` do it.
- Settings: use `openAgenticChatSettings()`, `selectSettingsTab("Agent")`,
  `setSettingSelect("Write file", "ask")`.
- Background tab: start the turn on tab 1, switch to tab 2 before the approval
  resolves, then assert `[data-ac="tab"]` `data-ac-state="needs-you"`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Approval card opens inline before a write (no modal) | `src/ui/approval-card.ts#ApprovalCard` | `test/e2e/specs/activity-line.e2e.ts#renders an approval as an inline card below the activity line, never a modal` | `covered` |
| A settled approval leaves; its step row says `Allowed by you` / `Denied by you` | `src/ui/transcript-view.ts#recordApproval`; `src/ui/activity-line.ts#recordApproval` | `test/e2e/specs/timeline-u4.e2e.ts#U4 #4: an approval waits below the block, then becomes a line on its row` | `covered` |
| A private path is blocked before the approval card (no card, no checkpoint, honest reason) | `src/agent/tool-call-controller.ts#privateTarget` | `test/ui/private-content.test.ts#a write to a private path is blocked before the approval card: no card, no checkpoint, an honest reason` | `partial` |
| Private rules: path glob or name, #tag, property=value | `src/vault/private-rules.ts#createPrivateMatcher` | `test/private-rules.test.ts#hides by path glob, nested tag, property value, and property key` (unit only) | `partial` |
| A private active note shows a lock chip and is never sent | `src/ui/context-chip-renderer.ts#renderPrivateNoteChip` | `test/ui/private-content.test.ts#a private active note shows a lock chip and nothing of it is sent` | `partial` |
| Stop resolves a pending approval as stopped | `src/ui/approval-card.ts#stop` | `test/e2e/specs/approval-deterministic.e2e.ts#resolves the approval card as stopped when the user stops the turn` | `covered` |
| Allow applies the change | `src/ui/approval-card.ts#render` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Deny is two-step and blocks the change | `src/ui/approval-card.ts#armDeny` | `test/e2e/specs/approval-deterministic.e2e.ts#continues after a denied scripted write without creating the note` | `covered` |
| Enter allows, Esc starts the deny | `src/ui/approval-card.ts#onKey` | `test/e2e/specs/approval-deterministic.e2e.ts#allows with Enter and starts the deny with Esc` | `covered` |
| Diff preview before an edit | `src/ui/approval-card.ts#renderPreview` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| Always allow remembers allow for this tool | `src/ui/approval-card.ts#render` | `test/e2e/specs/approval-deterministic.e2e.ts#Always allow remembers allow for the tool, so the next write does not ask` | `covered` |
| Approval audit records Allow once vs Always allow | `src/agent/action-audit-log.ts#buildApprovalAuditEvent` | `test/tool-call-controller.test.ts#records remember on the user's approval decision, so a log can tell the two apart` (unit only) | `partial` |
| Skill tools cannot be remembered | `src/ui/approval-card.ts#isCreateSkill` | `test/approval-memory.test.ts#never remembers allow for persistent skill tools and web downloads (injection gate)` (policy only) | `partial` |
| Global mutating gate persists | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` (persistence; behavior also exercised by `approval-deterministic.e2e.ts`) | `covered` |
| Per-tool override through settings | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` | `covered` |
| Per-tool deny flips to allow | `src/settings-tab-agent.ts#approvalDefinitions` | `test/approval.test.ts#honors explicit per-tool overrides for either direction` (policy only; the recorded probe was deleted in #393 T23) | `partial` |
| Working directories and `/add-dir` are gone | `src/ui/commands.ts#SLASH_COMMANDS` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts#routes /help, /init, and /compact locally without a model call` | `covered` |
| Safe asks before mutating tools | `src/agent/tool-call-controller.ts#beforeToolCall` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted write and undo removes the created note` | `covered` |
| Safe/YOLO toggle | `src/ui/chat-view.ts#syncControls`; `src/ui/chat-layout.ts#buildLayout` | `test/ui/chat-view-states.test.ts#the mode toggle flips Safe <-> YOLO when idle and refuses while streaming`; `test/e2e/specs/mobile-viewport.e2e.ts#keeps the mode readable when the label is hidden: the icon changes` | `covered` |
| An approval does not open the activity block | `src/ui/activity-line.ts#setNeedsYou` | `test/e2e/specs/activity-line.e2e.ts#renders an approval as an inline card below the activity line, never a modal`; `test/ui/chat-view-states.test.ts#streaming -> approval pending -> Allow -> idle: the inline card blocks the tool until allowed` | `covered` |
| `/plan` and the Plan badge are gone | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/smoke.e2e.ts#renders a scripted turn, answers /plan locally, runs /skill, and Stop clears a running turn` | `covered` |
| Invalid mode transition is blocked | `src/ui/chat-view.ts#setMode` | `test/ui/chat-view-states.test.ts#the mode toggle flips Safe <-> YOLO when idle and refuses while streaming` (happy-dom) | `partial` |
| Background-tab approval waits in its tab (orange dot) | `src/ui/chat-view.ts#confirmToolCallForTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#keeps a background tab's approval in that tab with an orange dot (no auto-switch)` | `covered` |
| Closing a tab settles its pending approval | `src/ui/chat-tabs.ts#closeTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#settles the pending card and drops the dot when the background tab is closed` | `covered` |
| Tall approval card keeps Allow and Deny on screen; create_skill body is folded (U7 #3) | `src/ui/approval-card.ts#renderCreateSkillPreview` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps Allow and Deny on screen for a tall approval card (U7 #3)` (tall write card in a browser; the create_skill fold is `test/ui/approval-card.test.ts` only) | `partial` |
| Approval card at phone width | `src/ui/approval-card.ts#ApprovalCard` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the approval card visible and touchable at phone width` | `covered` |
| Approved delete really leaves the vault (system trash that does nothing falls back to `.trash`) | `src/tools/vault/adapter-trash.ts#trashVaultEntry` | `test/e2e/specs/trash-fallback.e2e.ts#the note is gone from the vault when the tool says it moved it to trash` | `covered` |

## Gotchas

- Deny needs two clicks: the first enables the reason field, the second
  confirms.
- `deny` overrides `allow` at every layer. A per-tool deny overrides the global
  policy, and a remembered choice writes into the same `perTool` map.
- "Always allow" is hidden for `create_skill`. A remembered deny is no longer
  offered from the card; set it in settings.
- The plugin refuses mode changes while any tab streams.
- A background approval does not take focus or switch tabs. The card waits in
  its tab and shows when the user switches there.
- A card that settles after the user clicked into another pane does not pull
  focus back to the composer (`test/ui/chat-view-states.test.ts`).
- Closing the tab settles its pending card as stopped.
- WebDriver `clearValue` blurs; type into the deny reason with `browser.keys`.
