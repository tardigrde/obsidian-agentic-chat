# Open and compose

## Sub-features

- Entry points: ribbon icon, command palette, editor selection menu, single-file
  and multi-file context menus.
- Composer card: tab strip, textarea, context chip row, send and stop controls.
- Keyboard: Enter sends, Shift+Enter inserts a newline, ArrowUp/ArrowDown recall
  sent messages, Escape cancels a prompt edit.
- Autocomplete trigger for slash commands, skills, and `@` mentions.
- Attachments: active note, selected text, files, folders, images, and
  drag-and-drop.
- Empty-state suggestion chips.
- Quick Ask inline edit.

## How to get to it (user view)

- Click the ribbon icon (`messages-square`, "Open agentic chat").
- Command palette: `Agentic Chat: Open chat`, `Agentic Chat: New conversation`,
  or `Agentic Chat: Quick Ask inline edit`.
- Right-click a text selection in the editor: **Send selection to Agentic Chat**.
- Right-click a note or folder: **Send to Agentic Chat**. Multi-select adds
  **Send files to Agentic Chat**.
- Type in the composer at the bottom of the chat view.

## Driving it with the probe harness

```ts
await browser.executeObsidianCommand("agentic-chat:open-chat");
await $(".agentic-chat-view").waitForExist();

await $(".agentic-chat-input").setValue("hello");
await $(".agentic-chat-send").click();
```

- Submit through the send button, not a synthesized Enter key. The send button
  uses the same `submit()` route and avoids key-synthesis differences.
- Active note: open a Markdown note with `browser.executeObsidian`, then wait for
  `.agentic-chat-chip.is-active-note`.
- Quick Ask: select editor text, run `agentic-chat:quick-ask-inline-edit`, fill
  `.agentic-chat-quick-ask-instruction`, then click
  `.agentic-chat-quick-ask-accept`.
- There is no helper for real drag-and-drop, the ribbon, or the context menus.
  Drive those through the Obsidian UI if you add a check. Do not fake the
  handler.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Ribbon icon | `src/main.ts:93` | no committed check | `NONE` |
| Command palette: Open chat | `src/main.ts:95` | `test/e2e/specs/smoke.e2e.ts:45` | `covered` |
| Command palette: New conversation | `src/main.ts:101` | `test/session-actions.test.ts:153` (unit only) | `partial` |
| Command palette: Quick Ask inline edit | `src/main.ts:107` | `test/e2e/specs/smoke.e2e.ts:237` | `covered` |
| Editor selection context menu | `src/main.ts:164` | no committed check | `NONE` |
| File context menu | `src/main.ts:169` | no committed check | `NONE` |
| Files context menu (multi-select) | `src/main.ts:174` | no committed check | `NONE` |
| Composer card mounts | `src/ui/chat-view.ts:659` | `test/e2e/specs/smoke.e2e.ts:45` | `covered` |
| Empty-state suggestion chips | `src/ui/chat-view.ts:909` | no committed check | `NONE` |
| Enter sends | `src/ui/chat-view.ts:713` | `test/e2e/specs/smoke.e2e.ts:45` (send button path only) | `partial` |
| Shift+Enter inserts a newline | `src/ui/chat-view.ts:713` | no committed check | `NONE` |
| Send button | `src/ui/chat-view.ts:828` | `test/e2e/specs/approval-deterministic.e2e.ts:261` | `covered` |
| ArrowUp/ArrowDown recall | `src/ui/chat-view.ts:705` | `test/composer-history.test.ts:16` (unit only) | `partial` |
| Escape cancels edit | `src/ui/chat-view.ts:700` | `test/prompt-edit-state.test.ts:5` (unit only) | `partial` |
| Autocomplete menu opens | `src/ui/chat-view.ts:953` | `test/e2e/specs/autocomplete-dropup.e2e.ts:34` | `covered` |
| Autocomplete keys | `src/ui/autocomplete-menu.ts:108` | no committed check | `NONE` |
| `@` mention autocomplete | `src/ui/autocomplete.ts:80` | `test/autocomplete.test.ts:51` (detection only) | `partial` |
| Drag-and-drop attach | `src/ui/chat-view.ts:847` | `test/drag-drop.test.ts:4` (parser only) | `partial` |
| Active note auto-chip | `src/ui/chat-view.ts:2427` | `test/e2e/specs/smoke.e2e.ts:98` | `covered` |
| Ignored active note stays out | `src/ui/active-note.ts:54` | `test/e2e/specs/runtime-behavior.e2e.ts:194` | `covered` |
| Remove an attachment chip | `src/ui/chat-view.ts:2475` | `test/context-chip-renderer.test.ts:121` (unit only) | `partial` |
| Image attachment guard | `src/ui/chat-view.ts:2402` | `test/image-attachments.test.ts:4` (encoding only) | `partial` |
| Folder attachment menu | `src/ui/chat-view.ts:2519` | only `showFolderMenu()` calls it, and no production code calls that method | `unreachable` |
| Quick Ask accept | `src/ui/quick-ask-modal.ts:53` | `test/e2e/specs/smoke.e2e.ts:237` | `covered` |
| Quick Ask Enter accept | `src/ui/quick-ask-modal.ts:58` | no committed check | `NONE` |

## Gotchas

- `setValue` alone does not submit. Click `.agentic-chat-send`.
- `event.isComposing` blocks Enter during IME composition. Do not assert a send
  in the middle of a composition event.
- The chat view debounces autocomplete by 120 ms in `src/ui/chat-view.ts:938`.
  Wait for `.agentic-chat-autocomplete`, not for a fixed delay.
- The plugin suppresses the active note chip for ignored notes, non-Markdown
  files, and standing-instruction files such as `AGENTS.md`.
- A real drag uses Obsidian's internal drag manager. The parser unit test covers
  path handling only. It does not prove the drop gesture.
- Quick Ask applies a deterministic text transform. It is not a model call.
- The folder attachment picker is reachable only from the unused folder menu.
  Do not claim that users can reach it.
