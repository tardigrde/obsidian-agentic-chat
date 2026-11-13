# Sessions and tabs

## Sub-features

- Up to three independent tabs, each with its own session and agent service.
- Tab add, switch, close, busy dot, and needs-approval badge.
- Header **New chat** and **Conversation history** buttons.
- Conversation history modal: search, load, rename, delete.
- `/new`, `/sessions`, `/sessions clear --confirm`, and `/export`.
- Session persistence and reload from JSONL.
- Mobile layout for the history modal.

## How to get to it (user view)

- Tab strip above the composer: click a tab to switch, `+` to add, `x` to close.
- Header buttons at the right of the tab strip: **New chat** (square-pen) and
  **Conversation history** (history).
- Commands: `/new`, `/sessions`, `/export`.
- Command palette: `Agentic Chat: New conversation`.

## Driving it with the probe harness

```ts
await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-tab-add")?.click());
await browser.execute(() => document.querySelectorAll<HTMLElement>(".agentic-chat-tab")[1]?.click());
await $(".agentic-chat-session-list").waitForExist();
```

- Use `.agentic-chat-tab` for tabs, `.agentic-chat-tab.is-active` for the active
  one, `.agentic-chat-tab-add` for `+`, `.agentic-chat-tab-close` for `x`.
- Open history through `/sessions` in a deterministic spec. The header history
  button has no direct helper.
- Session rows: `.agentic-chat-session-row`, `.agentic-chat-session-main`,
  `.agentic-chat-session-rename`, `.agentic-chat-session-delete`,
  `.agentic-chat-session-search`.
- Export writes a note under `Agentic Chat Sessions/`. Assert with
  `browser.executeObsidian`. Do not rely on the info block alone.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Tab strip renders | `src/ui/chat-view.ts#closeTab` | `test/e2e/specs/smoke.e2e.ts#renders the unified composer card with a tab and textarea` | `covered` |
| `+` adds a tab | `src/ui/chat-view.ts#restoreDraft` | `test/e2e/specs/multi-tab-approval.e2e.ts#surfaces background tab approval with tab badge and session label (no auto-switch)` | `covered` |
| Switch between tabs | `src/ui/chat-view.ts#restoreDraft` | `test/e2e/specs/multi-tab-approval.e2e.ts#surfaces background tab approval with tab badge and session label (no auto-switch)` | `covered` |
| Busy dot on a streaming tab | `src/ui/chat-view.ts#tabLabel` | no committed check | `NONE` |
| Needs-approval tab badge | `src/ui/chat-view.ts#tabLabel` | `test/e2e/specs/multi-tab-approval.e2e.ts#surfaces background tab approval with tab badge and session label (no auto-switch)` | `covered` |
| `x` closes a tab | `src/ui/chat-view.ts#onActivate` | `test/e2e/specs/multi-tab-approval.e2e.ts#clears pending modal and badge when background tab is closed` (calls `closeTab`, does not click `x`) | `partial` |
| Closing the last tab starts a new conversation | `src/ui/chat-view.ts#switchToTab` | no committed check | `NONE` |
| Header New chat button | `src/ui/chat-view.ts#startNewConversation` | no committed check | `NONE` |
| Header history button | `src/ui/chat-view.ts#buildLayout` | no committed check | `NONE` |
| `/new` | `src/ui/chat-view.ts#dispatchPrompt` | `test/session-actions.test.ts#makeActions` (unit only) | `partial` |
| `/sessions` opens history | `src/ui/chat-view.ts#dispatchPrompt` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Search conversations | `src/ui/session-list-modal.ts#onOpen` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Rename a conversation | `src/ui/session-list-modal.ts#beginRename` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Delete a conversation | `src/ui/session-list-modal.ts#renderList` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Clear all conversations | `src/ui/session-workflow-controller.ts#SessionWorkflowController` | `test/session-workflow-controller.test.ts#does not report success or reset the transcript when clearing fails` (unit only) | `partial` |
| `/export` | `src/ui/slash/session.ts#exportSession` | `test/session-export.test.ts#session export` (renderer only) | `partial` |
| Reload a persisted session | `src/ui/slash/session.ts#exportSession` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Send waits for an in-flight session swap | `src/agent/session-actions.ts#commitSessionChange` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Failed swap restores the previous session or recovers on next send | `src/agent/session-actions.ts#truncateMessages` | `test/session-actions.test.ts#name: "new session"`; `test/session-actions.test.ts#restores the previous session when the targeted load fails after detach` | `partial` |
| A queued prompt is dropped on session change | `src/ui/session-activation-coordinator.ts#startNewConversation`; `src/ui/chat-view.ts#handleSlashCommand` | `test/chat-view-lifecycle.test.ts#clears an armed queued prompt when the session changes`; `test/chat-view-lifecycle.test.ts#clears a queued prompt before deleting the active session` | `partial` |
| A queued prompt flushes once the swap is live | `src/ui/chat-view.ts#submit` | `test/chat-view-lifecycle.test.ts#does not flush a queued prompt while the session swap is not live` | `partial` |
| Compaction rewrite rejects a changed session | `src/agent/compaction-runtime.ts#AgentCompactionRuntime` | `test/compaction-runtime.test.ts#keeps guard stop notices out of the summary prompt (#283)`; `test/session-invariants.test.ts#rejects a rewrite bound to a session that changed during the write` | `partial` |
| A crash during rewrite keeps the old transcript or the new one | `src/session/session-manager.ts#replaceSessionFile` | `test/session-rewrite-atomic.test.ts#keeps the original session when the rewrite write is torn` (unit only) | `partial` |
| A slow append stays in its original session file | `src/session/session-manager.ts#cleanupStaleSessionTemps` | `test/session-invariants.test.ts#does not append a slow entry to the new session after a swap` | `partial` |
| Do not open one session in two tabs | `src/ui/slash/session.ts#exportSession` | no committed check | `NONE` |
| History modal at phone width | `src/ui/session-list-modal.ts#onOpen` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the session history modal usable at phone width` | `covered` |

## Gotchas

- `MAX_TABS` is 3. The `+` control disappears at the cap.
- The `x` control exists only when more than one tab is open. Closing the last
  tab resets the view to a fresh conversation instead.
- The view does not load a session twice when another tab already has it open.
  It switches to the existing tab.
- Rename commits on Enter or blur. Escape cancels.
- Delete removes the row before the file operation finishes. A failure restores
  the row.
- Export needs at least one user/assistant turn and writes a Markdown note.
- The header buttons and the tab `x` have no direct e2e helper. A proof that
  calls `closeTab()` is not proof of the click target.
