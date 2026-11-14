# Subagents and context

## Sub-features

- The `subagent` tool starts one child agent per call, keeps its context
  isolated, and returns a summary.
- The built-in Explorer role does read-only vault inspection.
- The subagent pool caps parallel dispatches at ten in flight. The rest queue.
- Live child status tree, per-child Stop, and a settled summary with time, tokens,
  and cost.
- `/agent` picker and `/agent <name> <task>`.
- The subagent timeout setting.
- Replay of done, stopped, and failed dispatches from persisted details.
- Context handling: serialization, attachment budgets, ignore-list withholding,
  context chips, context-window bar, and source chips. See
  [Open and compose](./open-and-compose.md) for the attachment entry points.

## How to get to it (user view)

- Type `/agent` to see the role picker, or `/agent explorer <task>`.
- Let the model call the `subagent` tool.
- Open Settings, select **Advanced**, then find **Subagent timeout** under **Subagents**.
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
  outgoing prompt. Do not assert only the chip label.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/agent` with no argument (picker) | `src/ui/slash/agents.ts#showAgentList` | no committed check | `NONE` |
| `/agent <name> <task>` | `src/ui/slash/agents.ts#showSkillList` | `test/command-dispatcher.test.ts#resolves a named subagent with the trimmed task` (unit only) | `partial` |
| Model calls the `subagent` tool | `src/tools/subagent-tool.ts#toPersistedChild` | `test/subagents.test.ts#aborts in-flight children when the dispatch signal aborts` (unit only) | `partial` |
| Built-in Explorer role | `src/agent/subagents.ts#BUILTIN_AGENT_ROLES` | `test/subagent-runtime.test.ts#makeRuntime` (unit only) | `partial` |
| Parallel cap of ten and queueing | `src/tools/subagent-tool.ts#MAX_CONCURRENCY` | `test/subagents.test.ts#caps concurrent dispatches at 10 and queues the rest, promoting on stop` (unit only) | `partial` |
| Live child status tree | `src/ui/assistant-bubble.ts#updateStep` | `test/e2e/specs/design-audit.e2e.ts#captures the full design journey screenshots` (disabled unless `AGENTIC_CHAT_DESIGN_AUDIT=1`) | `partial` |
| Per-child Stop button | `src/ui/subagent-tree.ts#renderSubagentHeader` | `test/subagents.test.ts#lets a caller abort one dispatch without stopping its siblings` (abort path only, no button click) | `partial` |
| Replay a done dispatch | `src/ui/assistant-bubble.ts#endStep` | `test/e2e/specs/subagent-replay.e2e.ts#rehydrates a done dispatch from tool_execution_end alone (no updateStep), collapsed with summary` | `covered` |
| Replay a stopped dispatch | `src/ui/assistant-bubble.ts#endStep` | `test/e2e/specs/subagent-replay.e2e.ts#rehydrates an aborted dispatch as stopped (red) without re-running` | `covered` |
| Replay a failed dispatch | `src/ui/assistant-bubble.ts#endStep` | `test/e2e/specs/subagent-replay.e2e.ts#rehydrates an error dispatch as failed (red) from persisted details` | `covered` |
| Subagent timeout behavior | `src/agent/subagent-runtime.ts#AgentSubagentRuntime` | `test/subagents.test.ts#settles a timed-out child as aborted without rejecting the dispatch` (unit only) | `partial` |
| Subagent timeout | `src/settings-tab-agent.ts#row("Subagent timeout"` | no committed check | `NONE` |
| Attachment budget: inline or path reference | `src/ui/attachments.ts#buildAttachmentSection` | `test/attachments.test.ts#switches to a path-only reference when over the budget (no body inlined)` (unit only) | `partial` |
| Ignore-list withholding | `src/ui/attachments.ts#buildAttachmentSection` | `test/attachments.test.ts#never inlines content for a restricted (ignore-listed) path` (unit only) | `partial` |
| Context chips order and removal | `src/ui/context-chip-renderer.ts#renderContextChips` | `test/context-chip-renderer.test.ts#renders the active note and explicit attachments in a stable order` (unit only) | `partial` |
| Source chips and note open | `src/ui/assistant-bubble.ts#renderSourceChips` | `test/e2e/specs/beautifului-polish.e2e.ts#renders deduped source chips only for read-style tools and opens the note on click` | `covered` |
| Context-window bar | `src/ui/chat-view.ts#buildLayout` | `test/e2e/probe/scenarios/context-readout.e2e.ts#shows the full-load percentage with a section breakdown` | `covered` |

## Gotchas

- Explorer does read-only inspection. It inherits the parent approval policy,
  and the parent strips tools it may not use.
- One `subagent` call is one child. To run several, emit several calls in one
  message. The pool runs ten and queues the rest.
- Stop is per child, not per dispatch. A stopped child returns a normal result so
  the parent does not re-dispatch it.
- Replay strips `stopId` and `transcript`. A replayed card must not show Stop and
  must not re-run the child.
- The timeout settles a child as stopped, not failed.
- The plugin inlines attachment bodies only up to the budget. Larger notes
  become a path reference for `read`.
- The plugin never inlines ignore-listed paths, even when the user attaches them
  explicitly.
- The folder attachment picker is reachable only from the unused folder menu.
  Do not claim that users can reach it.
- The assistant bubble dedupes source chips and caps them at eight.
