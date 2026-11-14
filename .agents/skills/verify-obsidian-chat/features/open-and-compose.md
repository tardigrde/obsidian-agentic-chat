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
| Ribbon icon | `src/main.ts#onload` | no committed check | `NONE` |
| Command palette: Open chat | `src/main.ts#id: "open-chat"` | `test/e2e/specs/smoke.e2e.ts#renders the unified composer card with a tab and textarea` | `covered` |
| Command palette: New conversation | `src/main.ts#id: "new-conversation"` | `test/session-actions.test.ts#makeActions` (unit only) | `partial` |
| Command palette: Quick Ask inline edit | `src/main.ts#id: "quick-ask-inline-edit"` | `test/e2e/specs/smoke.e2e.ts#applies a Quick Ask edit to selected editor text without a model call` | `covered` |
| Editor selection context menu | `src/main.ts#registerContextMenus` | no committed check | `NONE` |
| File context menu | `src/main.ts#registerContextMenus` | no committed check | `NONE` |
| Files context menu (multi-select) | `src/main.ts#registerContextMenus` | no committed check | `NONE` |
| Composer card mounts | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/smoke.e2e.ts#renders the unified composer card with a tab and textarea` | `covered` |
| Empty-state suggestion chips | `src/ui/chat-view.ts#renderEmptyState` | no committed check | `NONE` |
| Enter sends while idle | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/composer-paths.e2e.ts#sends with Enter while the agent is idle` | `covered` |
| Enter steers while the agent runs | `src/ui/composer-input.ts#resolveComposerAction` | `test/e2e/specs/composer-paths.e2e.ts#steers after a successful tool call while the agent is running` | `covered` |
| Shift+Enter inserts a newline | `src/ui/chat-view.ts#buildLayout` | `test/e2e/specs/composer-paths.e2e.ts#inserts a newline with Shift+Enter without sending` | `covered` |
| Send button | `src/ui/chat-layout.ts#cls: ["agentic-chat-send", "mod-cta"]` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| ArrowUp/ArrowDown recall | `src/ui/chat-view.ts#buildLayout` | `test/composer-history.test.ts#recalls older entries with Up and swallows Up at the oldest entry without wrapping` (unit only) | `partial` |
| Escape cancels edit | `src/ui/chat-view.ts#buildLayout` | `test/prompt-edit-state.test.ts#starts editing a prompt and restores the original draft on cancel` (unit only) | `partial` |
| Autocomplete menu opens | `src/ui/composer-controller.ts#updateAutocomplete` | `test/e2e/specs/autocomplete-dropup.e2e.ts#renders the /sta menu above the input card, fully visible` | `covered` |
| Autocomplete keys | `src/ui/autocomplete-menu.ts#handleKey` | no committed check | `NONE` |
| `@` mention autocomplete | `src/ui/autocomplete.ts#detectQuery` | `test/autocomplete.test.ts#detects a mention after whitespace mid-message` (detection only) | `partial` |
| Drag-and-drop attach | `src/ui/chat-view.ts#handleDrop` | `test/drag-drop.test.ts#parseDroppedVaultPath` (parser only) | `partial` |
| Active note auto-chip | `src/ui/chat-view.ts#private effectiveActiveNote()` | `test/e2e/specs/smoke.e2e.ts#auto-attaches the active note as a context chip` | `covered` |
| Ignored active note stays out | `src/ui/active-note.ts#autoActiveNotePath` | `test/e2e/specs/runtime-behavior.e2e.ts#does not auto-attach an ignored active note` | `covered` |
| Remove an attachment chip | `src/ui/chat-view.ts#renderChips` | `test/context-chip-renderer.test.ts#wires remove callbacks to the matching chip` (unit only) | `partial` |
| Image attachment guard | `src/ui/chat-view.ts#addAttachment` | `test/image-attachments.test.ts#collectUserImageThumbs,` (encoding only) | `partial` |
| Quick Ask accept | `src/ui/quick-ask-modal.ts#onOpen` | `test/e2e/specs/smoke.e2e.ts#applies a Quick Ask edit to selected editor text without a model call` | `covered` |
| Quick Ask Enter accept | `src/ui/quick-ask-modal.ts#onOpen` | no committed check | `NONE` |

## Gotchas

- `setValue` alone does not submit. Click `.agentic-chat-send`.
- `event.isComposing` blocks Enter during IME composition. Do not assert a send
  in the middle of a composition event.
- The chat view debounces autocomplete by 120 ms in `src/ui/chat-view.ts#cancelAutocomplete`.
  Wait for `.agentic-chat-autocomplete`, not for a fixed delay.
- The plugin suppresses the active note chip for ignored notes, non-Markdown
  files, and standing-instruction files such as `AGENTS.md`.
- A real drag uses Obsidian's internal drag manager. The parser unit test covers
  path handling only. It does not prove the drop gesture.
- Quick Ask applies a deterministic text transform. It is not a model call.
- The folder attachment picker is reachable only from the unused folder menu.
  Do not claim that users can reach it.
