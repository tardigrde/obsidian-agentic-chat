# Sessions and tabs

## Sub-features

- Up to five independent tabs, each with its own session and agent service.
- Tab add, switch, close, rename (tab label), status dots, `+N` overflow menu.
- Header **New tab** (`+`) and **Conversation history** buttons.
- Conversation history modal: search, load, rename, delete.
- `/new`, `/sessions`, `/sessions clear --confirm`, and `/export`.
- Session persistence and reload from JSONL.
- Mobile layout for the history modal.

## How to get to it (user view)

- Header row above the transcript: click a tab to switch, `+` to add, `x` (on
  hover or focus, desktop only) to close. Left/Right/Home/End move between tabs.
- A tab shows its number, or its label once the user names it. The label is a
  `tab_label` entry in the session JSONL; the session name does not change.
- Rename: double-click (desktop), long-press 500 ms (touch), or the tab menu
  item "Rename current tab". Enter or blur saves, Esc cancels, empty clears.
- The tab menu (`+N ▾` when tabs are hidden, `⋯` otherwise) lists hidden tabs,
  then Rename current tab, Open from history…, and Close current tab.
- Status dots, most urgent first: needs you, error, working, new reply.
- Commands: `/new`, `/sessions`, `/export`.
- Command palette: `Agentic Chat: New conversation`.

## Driving it with the probe harness

```ts
await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="tab-add"]')?.click());
await browser.execute(() => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.click());
await $(".agentic-chat-session-list").waitForExist();
```

- Hooks: `[data-ac="tab"]` (with `is-active`, `is-overflow`, and `data-ac-state`
  = `needs-you|error|running|unread|idle`), `tab-label`, `tab-input`, `tab-add`,
  `tab-close`, `tab-overflow`, `tab-menu`.
- Type into the rename input with `browser.keys`: WebDriver's `clearValue`
  blurs the input, and blur commits the rename.
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
| Tab strip renders | `src/ui/chat-view.ts#syncTabStrip` | `test/e2e/specs/tabs-v2.e2e.ts#puts the tabs in a header row above the transcript` | `covered` |
| Rename a tab (double-click; label persists, name stays) | `src/ui/tab-strip.ts#beginRename` | `test/e2e/specs/tabs-v2.e2e.ts#renames a tab by double-click; the label survives a reload and the session name does not change` | `covered` |
| Rename from the tab menu; Esc cancels | `src/ui/tab-strip.ts#renderMenu` | `test/e2e/specs/tabs-v2.e2e.ts#renames the current tab from the menu; Esc cancels` | `covered` |
| Long-press rename on touch | `src/ui/tab-strip.ts#wireLongPress` | `test/e2e/specs/tabs-v2.e2e.ts#long-press renames on touch, and the close button is only in the menu there` (synthetic touch pointer event) | `partial` |
| Five tabs, `+N` overflow menu | `src/ui/tab-strip.ts#layout` | `test/e2e/specs/tabs-v2.e2e.ts#holds five tabs; in a 360px pane the rest go into the +N menu` | `covered` |
| Tab label is its own JSONL field | `src/session/session-manager.ts#appendTabLabel` | `test/session-tab-label.test.ts#stores the label as a tab_label entry and keeps the session name` (unit); the reload half is in `test/e2e/specs/tabs-v2.e2e.ts#renames a tab by double-click; the label survives a reload and the session name does not change` | `partial` |
| `+` adds a tab | `src/ui/chat-tabs.ts#addTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#keeps a background tab's approval in that tab with an orange dot (no auto-switch)` | `covered` |
| Switch between tabs | `src/ui/chat-view.ts#switchToTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#keeps a background tab's approval in that tab with an orange dot (no auto-switch)` | `covered` |
| Status dot on a tab (most urgent wins) | `src/ui/tab-status.ts#tabStatus` | `test/tab-status.test.ts#picks one status per tab, most urgent first` (unit only) | `partial` |
| Needs-you tab dot | `src/ui/chat-view.ts#tabLabel` | `test/e2e/specs/multi-tab-approval.e2e.ts#keeps a background tab's approval in that tab with an orange dot (no auto-switch)` | `covered` |
| `x` closes a tab | `src/ui/tab-strip.ts#renderTab` | `test/e2e/specs/multi-tab-approval.e2e.ts#settles the pending card and drops the dot when the background tab is closed` (calls `closeTab`, does not click `x`) | `partial` |
| Closing the last tab starts a new conversation | `src/ui/chat-tabs.ts#closeTab` | `test/chat-view-tabs.test.ts#starts a new conversation instead of closing the only tab` (unit only) | `partial` |
| New conversation in the active tab (`/new`, palette; the header button is gone in UI v2) | `src/ui/chat-view.ts#startNewConversation` | `test/ui/chat-sessions.test.ts#history lists the earlier conversation and loading it restores the transcript` (happy-dom) | `partial` |
| Header history button | `src/ui/chat-view.ts#buildLayout` | `test/ui/chat-sessions.test.ts#history lists the earlier conversation and loading it restores the transcript` (happy-dom) | `partial` |
| `/new` | `src/ui/chat-turn.ts#dispatchPrompt` | `test/session-actions.test.ts#makeActions` (unit only) | `partial` |
| `/sessions` opens history | `src/ui/chat-turn.ts#dispatchPrompt` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Search conversations | `src/ui/session-list-modal.ts#onOpen` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Rename a conversation | `src/ui/session-list-modal.ts#beginRename` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Delete a conversation | `src/ui/session-list-modal.ts#renderList` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Clear all conversations | `src/ui/session-workflow-controller.ts#async run(arg: string)` | `test/e2e/specs/session-delete-tabs.e2e.ts#/sessions clear in one tab leaves the other tab on a valid, listed session` | `covered` |
| Delete a conversation that another tab has open | `src/ui/chat-actions.ts#deleteSessionFromList` | `test/e2e/specs/session-delete-tabs.e2e.ts#a tab whose conversation is deleted from another tab keeps a valid, listed session` | `covered` |
| A deleted conversation goes to the vault `.trash` | `src/session/session-manager.ts#trashSessionFile` | `test/e2e/specs/session-delete-tabs.e2e.ts#a tab whose conversation is deleted from another tab keeps a valid, listed session` | `covered` |
| History lists an unreadable session file (delete only) | `src/session/session-manager.ts#unreadableSessionInfo`; `src/ui/session-list-modal.ts#renderList` | `test/e2e/specs/session-delete-tabs.e2e.ts#history shows an unreadable session file as a row the user can delete` | `covered` |
| A background tab loading a session during clear starts fresh | `src/agent/session-actions.ts#releaseDeletedSession` | `test/session-actions.test.ts#resets a background tab whose in-flight load landed on a cleared session` (unit only) | `partial` |
| History shows an error when listing fails | `src/ui/session-workflow-controller.ts#openList` | `test/session-workflow-controller.test.ts#shows an error, and does not reject, when listing conversations fails` (unit only) | `partial` |
| `/export` | `src/ui/slash/session.ts#exportSession` | `test/session-export.test.ts#session export` (renderer only) | `partial` |
| Reload a persisted session | `src/ui/slash/session.ts#exportSession` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| Send waits for an in-flight session swap | `src/agent/session-actions.ts#commitSessionChange` | `test/agent-service.test.ts#blocks a prompt when the session changes during turn preparation` | `partial` |
| Failed swap restores the previous session or recovers on next send | `src/agent/session-actions.ts#recoverLiveSession` | `test/session-actions.test.ts#name: "new session"`; `test/session-actions.test.ts#restores the previous session when the targeted load fails after detach` | `partial` |
| A queued prompt is dropped on session change | `src/ui/session-activation-coordinator.ts#startNewConversation`; `src/ui/chat-view.ts#handleSlashCommand` | `test/chat-view-lifecycle.test.ts#clears an armed queued prompt when the session changes`; `test/chat-view-lifecycle.test.ts#clears a queued prompt before deleting the active session` | `partial` |
| A queued prompt flushes once the swap is live | `src/ui/chat-view.ts#submit` | `test/chat-view-lifecycle.test.ts#does not flush a queued prompt while the session swap is not live` | `partial` |
| Compaction rewrite rejects a changed session | `src/agent/compaction-runtime.ts#AgentCompactionRuntime` | `test/compaction-runtime.test.ts#keeps guard stop notices out of the summary prompt (#283)`; `test/session-invariants.test.ts#rejects a rewrite bound to a session that changed during the write` | `partial` |
| A crash during rewrite keeps the old transcript or the new one | `src/session/session-manager.ts#replaceSessionFile` | `test/session-rewrite-atomic.test.ts#keeps the original session when the rewrite write is torn` (unit only) | `partial` |
| A slow append stays in its original session file | `src/session/session-manager.ts#appendEntry` | `test/session-invariants.test.ts#does not append a slow entry to the new session after a swap` | `partial` |
| Do not open one session in two tabs | `src/ui/slash/session.ts#exportSession` | no committed check | `NONE` |
| History modal at phone width | `src/ui/session-list-modal.ts#onOpen` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the session history modal usable at phone width` | `covered` |

## Gotchas

- `MAX_TABS` is 5. The `+` button is disabled at the cap.
- The `x` control exists only when more than one tab is open. Closing the last
  tab resets the view to a fresh conversation instead.
- The view does not load a session twice when another tab already has it open.
  It switches to the existing tab.
- Rename commits on Enter or blur. Escape cancels.
- Delete removes the row before the file operation finishes. A failure restores
  the row.
- Export needs at least one user/assistant turn and writes a Markdown note.
- The tab `x` has no direct e2e helper. A proof that calls `closeTab()` is not
  proof of the click target.
