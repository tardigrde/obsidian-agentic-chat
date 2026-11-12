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
| Tab strip renders | `src/ui/chat-view.ts:455` | `test/e2e/specs/smoke.e2e.ts:45` | `covered` |
| `+` adds a tab | `src/ui/chat-view.ts:395` | `test/e2e/specs/multi-tab-approval.e2e.ts:102` | `covered` |
| Switch between tabs | `src/ui/chat-view.ts:383` | `test/e2e/specs/multi-tab-approval.e2e.ts:102` | `covered` |
| Busy dot on a streaming tab | `src/ui/chat-view.ts:467` | no committed check | `NONE` |
| Needs-approval tab badge | `src/ui/chat-view.ts:468` | `test/e2e/specs/multi-tab-approval.e2e.ts:102` | `covered` |
| `x` closes a tab | `src/ui/chat-view.ts:474` | `test/e2e/specs/multi-tab-approval.e2e.ts:167` (calls `closeTab`, does not click `x`) | `partial` |
| Closing the last tab starts a new conversation | `src/ui/chat-view.ts:414` | no committed check | `NONE` |
| Header New chat button | `src/ui/chat-view.ts:650` | no committed check | `NONE` |
| Header history button | `src/ui/chat-view.ts:656` | no committed check | `NONE` |
| `/new` | `src/ui/chat-view.ts:1620` | `test/session-actions.test.ts:153` (unit only) | `partial` |
| `/sessions` opens history | `src/ui/chat-view.ts:1623` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| Search conversations | `src/ui/session-list-modal.ts:49` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| Rename a conversation | `src/ui/session-list-modal.ts:143` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| Delete a conversation | `src/ui/session-list-modal.ts:112` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| Clear all conversations | `src/ui/session-workflow-controller.ts:20` | `test/session-workflow-controller.test.ts:121` (unit only) | `partial` |
| `/export` | `src/ui/chat-view.ts:2121` | `test/session-export.test.ts:31` (renderer only) | `partial` |
| Reload a persisted session | `src/ui/chat-view.ts:2253` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| Send waits for an in-flight session swap | `src/agent/session-actions.ts:63` | `test/agent-service.test.ts:1133` | `partial` |
| Failed swap restores the previous session or recovers on next send | `src/agent/session-actions.ts:273` | `test/session-actions.test.ts:242`; `test/session-actions.test.ts:267` | `partial` |
| A queued prompt is dropped on session change | `src/ui/session-activation-coordinator.ts:86`; `src/ui/chat-view.ts:1721` | `test/chat-view-lifecycle.test.ts:7`; `test/chat-view-lifecycle.test.ts:118` | `partial` |
| A queued prompt flushes once the swap is live | `src/ui/chat-view.ts:1262` | `test/chat-view-lifecycle.test.ts:63` | `partial` |
| Compaction rewrite rejects a changed session | `src/agent/compaction-runtime.ts:250` | `test/compaction-runtime.test.ts:354`; `test/session-invariants.test.ts:129` | `partial` |
| A crash during rewrite keeps the old transcript or the new one | `src/session/session-manager.ts:454` | `test/session-rewrite-atomic.test.ts:82` (unit only) | `partial` |
| A slow append stays in its original session file | `src/session/session-manager.ts:552` | `test/session-invariants.test.ts:91` | `partial` |
| Do not open one session in two tabs | `src/ui/chat-view.ts:2253` | no committed check | `NONE` |
| History modal at phone width | `src/ui/session-list-modal.ts:43` | `test/e2e/specs/mobile-viewport.e2e.ts:446` | `covered` |

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
