# Subagents and context

## Sub-features

- `subagent` tool: one call, one child agent, isolated context, summary returned.
- Built-in Explorer role: read-only vault recon.
- Parallel dispatches, capped at ten in flight; the rest queue.
- Live child status tree, per-child Stop, and a settled summary with time, tokens,
  and cost.
- `/agent` picker and `/agent <name> <task>`.
- Subagent timeout setting.
- Replay of done, stopped, and failed dispatches from persisted details.
- Context handling: serialization, attachment budgets, ignore-list withholding,
  context chips, context-window bar, and source chips. Attachment entry points
  are mapped in [Open and compose](./open-and-compose.md).

## How to get to it (user POV)

- Type `/agent` to see the role picker, or `/agent explorer <task>`.
- Let the model call the `subagent` tool.
- Settings → **Resources** → **Subagent timeout**.
- For active-note, `@` mention, context-menu, drag-and-drop, folder, and image
  attachments, see [Open and compose](./open-and-compose.md).

## Driving it with the probe harness

```ts
await browser.executeObsidianCommand("agentic-chat:open-chat");
await $(".agentic-chat-input").setValue("/agent");
await $(".agentic-chat-send").click();
await $(".agentic-chat-action-list").waitForExist();
```

- Subagent replay: inject `tool_execution_start` and `tool_execution_end` with
  `details.children`, as `test/e2e/specs/subagent-replay.e2e.ts` does.
- Live child progress uses `tool_execution_update` with `details.children`.
- Per-child Stop: `.agentic-chat-subagent-stop` inside the running child row.
- Assert attachment content through `buildPromptContext` unit tests or the
  outgoing prompt, not only the chip label.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/agent` with no argument (picker) | `src/ui/chat-view.ts:2052` | no committed check | `NONE` |
| `/agent <name> <task>` | `src/ui/chat-view.ts:2039` | `test/command-dispatcher.test.ts:54` (unit only) | `partial` |
| Model calls the `subagent` tool | `src/tools/subagent-tool.ts:111` | `test/subagents.test.ts:323` (unit only) | `partial` |
| Built-in Explorer role | `src/agent/subagents.ts:34` | `test/subagent-runtime.test.ts:147` (unit only) | `partial` |
| Parallel cap of ten and queueing | `src/tools/subagent-tool.ts:13` | `test/subagents.test.ts:505` (unit only) | `partial` |
| Live child status tree | `src/ui/assistant-bubble.ts:442` | `test/e2e/specs/design-audit.e2e.ts:57` (disabled unless `AGENTIC_CHAT_DESIGN_AUDIT=1`) | `partial` |
| Per-child Stop button | `src/ui/assistant-bubble.ts:547` | `test/subagents.test.ts:363` (abort path only, no button click) | `partial` |
| Replay a done dispatch | `src/ui/assistant-bubble.ts:622` | `test/e2e/specs/subagent-replay.e2e.ts:90` | `covered` |
| Replay a stopped dispatch | `src/ui/assistant-bubble.ts:622` | `test/e2e/specs/subagent-replay.e2e.ts:128` | `covered` |
| Replay a failed dispatch | `src/ui/assistant-bubble.ts:622` | `test/e2e/specs/subagent-replay.e2e.ts:146` | `covered` |
| Subagent timeout behavior | `src/agent/subagent-runtime.ts:64` | `test/subagents.test.ts:428` (unit only) | `partial` |
| Subagent timeout setting row | `src/settings.ts:2098` | no committed check | `NONE` |
| Attachment budget: inline or path reference | `src/ui/attachments.ts:42` | `test/attachments.test.ts:17` | `covered` |
| Ignore-list withholding | `src/ui/attachments.ts:39` | `test/attachments.test.ts:37` | `covered` |
| Context chips order and removal | `src/ui/chat-view.ts:2460` | `test/context-chip-renderer.test.ts:85` | `covered` |
| Source chips and note open | `src/ui/assistant-bubble.ts:743` | `test/e2e/specs/beautifului-polish.e2e.ts:198` | `covered` |
| `showFolderMenu()` | `src/ui/working-directory-workflow-controller.ts:21` | only a unit test calls it; no production caller | `unreachable` |
| `attachFolderMenuItems()` | `src/ui/working-directory-workflow-controller.ts:48` | no caller in `src/` or `test/` | `unreachable` |
| Context-window bar | `src/ui/chat-view.ts:775` | `test/e2e/specs/smoke.e2e.ts:179` (existence only) | `partial` |

## Gotchas

- Explorer is read-only recon. It inherits the parent approval policy, and the
  parent strips tools it may not use.
- One `subagent` call is one child. To run several, emit several calls in one
  message; the pool runs ten and queues the rest.
- Stop is per child, not per dispatch. A stopped child returns a normal result so
  the parent does not re-dispatch it.
- Replay strips `stopId` and `transcript`. A replayed card must not show Stop and
  must not re-run the child.
- The timeout settles a child as stopped, not failed.
- Attachment bodies are inlined only up to the budget. Larger notes become a
  path reference for `read`.
- Ignore-listed paths are never inlined, even when explicitly attached.
- The folder attachment picker is reachable only from the unused folder menu.
  Do not claim it as a working user path.
- Source chips are deduped and capped at eight.
