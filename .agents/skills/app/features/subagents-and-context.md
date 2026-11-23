# Subagents and context

## Sub-features

- The `subagent` tool starts one child agent per call, keeps its context
  isolated, and returns a summary.
- The built-in Explorer role does read-only vault inspection.
- The subagent pool runs `maxParallelSubagents` (default 10) in flight. The rest queue.
- `action: "continue"` sends a follow-up to a kept child (the last 10 per tab).
- Live child status tree, per-child Stop, and a settled summary with time, tokens,
  and cost.
- `/agent` picker and `/agent <name> <task>`.
- No turn cap and no timeout; the spend cap counts each child model call.
- Replay of done, stopped, and failed dispatches from persisted details.
- Context handling: serialization, attachment budgets, ignore-list withholding,
  context chips, context-window bar, and source chips. See
  [Open and compose](./open-and-compose.md) for the attachment entry points.

## How to get to it (user view)

- Type `/agent` to see the role picker, or `/agent explorer <task>`.
- Let the model call the `subagent` tool.
- Open Settings, select **Advanced**, then find **Parallel subagents** under **Subagents**.
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
  `details.children`, as `test/ui/chat-render.test.ts` and `test/ui/chat-sessions.test.ts` do.
- Live child progress uses `tool_execution_update` with `details.children`.
- Per-child Stop: `.agentic-chat-subagent-stop` inside the running child row.
- Assert attachment content through `buildPromptContext` unit tests or the
  outgoing prompt. Do not assert only the chip label.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/agent` with no argument (picker) | `src/ui/slash/agents.ts#showAgentList` | no committed check | `NONE` |
| `/agent <name> <task>` | `src/ui/slash/agents.ts#showSkillList` | `test/command-dispatcher.test.ts#resolves a named subagent with the trimmed task` (unit only) | `partial` |
| Model calls the `subagent` tool; the child runs in the background and the call returns at once (U5 #1) | `src/tools/subagent-tool.ts#runInBackground` | `test/subagents.test.ts#returns at once with the child id, then delivers the report with usage` (unit only) | `partial` |
| The child's report reaches the parent: steered into a running turn, or a new turn when idle (U5 #1) | `src/agent/subagent-reports.ts#SubagentReportDelivery` | `test/e2e/specs/timeline-u4.e2e.ts#U5 #1-#3: a subagent runs in the background; the turn ends, the row keeps running, the report starts a turn` | `covered` |
| The parent's Stop does not stop a child; each child stops on its own (U5 #1) | `src/tools/subagent-tool.ts#SubagentRegistry` | `test/subagents.test.ts#the parent's Stop signal does not stop a child; its own stop does (owner, 2026-11-23)` (unit only) | `partial` |
| `subagent` actions `stop` and `status` | `src/tools/subagent-tool.ts#stopResult` | `test/subagents.test.ts#stops a running child with {action: "stop", id} and lists children with {action: "status"}` (unit only) | `partial` |
| Built-in Explorer role | `src/agent/subagents.ts#BUILTIN_AGENT_ROLES` | `test/subagent-runtime.test.ts#makeRuntime` (unit only) | `partial` |
| Child prompt: a child base, the role prompt, the vault's standing instructions (U5 #6) | `src/agent/subagent-runtime.ts#childSystemPrompt` | `test/subagent-runtime.test.ts#gives a child the trust boundary and the vault's standing instructions, not only its role prompt` (unit only) | `partial` |
| Hard per-chat limit (setting, default ten): a start over the limit fails and names it (U5) | `src/tools/subagent-tool.ts#DEFAULT_CONCURRENCY` | `test/subagents.test.ts#enforces a hard per-chat limit: a start over maxParallelSubagents fails and names the limit` (unit only) | `partial` |
| One row per child in the activity block, no separate section; the row's spinner, clock, and Stop follow the child (U5 #2, #3) | `src/ui/subagent-tree.ts#SubagentChildView` | `test/e2e/specs/timeline-u4.e2e.ts#U5 #1-#3: a subagent runs in the background; the turn ends, the row keeps running, the report starts a turn` | `covered` |
| Per-child Stop button | `src/ui/subagent-tree.ts#renderStop` | `test/ui/chat-render.test.ts#has no separate Subagents section; the row keeps its spinner and Stop after the parent turn ends` (happy-dom) | `partial` |
| A report renders as an event, not the user's bubble | `src/ui/transcript-view.ts#renderSubagentReport` | `test/ui/chat-render.test.ts#renders a report message as an event, not as the user's bubble` (happy-dom) | `partial` |
| A stopped child reads stopped (red), never a green check | `src/ui/subagent-tree.ts#SubagentChildView` | `test/ui/chat-render.test.ts#labels a stopped child as stopped, with a red icon, never a green check` (happy-dom) | `partial` |
| No child turn cap: a child works past 10 turns and returns its report | `src/agent/subagent-runtime.ts#AgentSubagentRuntime` | `test/ui/no-turn-cap.test.ts#a subagent runs past the old 10-turn child cap and returns its report` | `partial` |
| The spend cap stops a running subagent | `src/agent/agent-service.ts#enforceSpendCap` | `test/ui/no-turn-cap.test.ts#the spend cap stops a running subagent mid-run, not only after the dispatch returns (U4 #9)` | `partial` |
| Continue a kept child (`action: "continue"`) | `src/tools/subagent-tool.ts#SubagentRegistry` | `test/subagents.test.ts#continues a finished child by id with its context intact ({action: "continue"})` (unit only) | `partial` |
| A long subagent report is kept in full as an artifact; the row has Open full report (U5 #13) | `src/tools/subagent-tool.ts#keepFullReport` | `test/subagents.test.ts#U3 #11: keeps the full oversized report as an artifact; the model gets a pointer, the row an Open link id` (unit only) | `partial` |
| Parallel subagents setting | `src/settings-tab-agent.ts#subagentDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#has no turn cap or subagent timeout; persists and clamps Parallel subagents (U4)` | `covered` |
| Attachment budget: inline or path reference | `src/ui/attachments.ts#buildAttachmentSection` | `test/attachments.test.ts#switches to a path-only reference when over the budget (no body inlined)` (unit only) | `partial` |
| Ignore-list withholding | `src/ui/attachments.ts#buildAttachmentSection` | `test/attachments.test.ts#never inlines content for a restricted (ignore-listed) path` (unit only) | `partial` |
| Text context (note attachments, selected text, folder listings) sent once per session; the active note is a pointer only, resent when it changes; images are not deduped | `src/ui/context-builder.ts#dedupeSection` | `test/ui/chat-sessions.test.ts#U7 #4: never sends the active note body; the pointer follows the active note and is not repeated while unchanged` (happy-dom) | `partial` |
| `read` refuses a binary file | `src/tools/vault/read-tools.ts#binaryReadError` | `test/vault-tools.test.ts#U3 #9: refuses a binary file with a clear error instead of mangled text` (unit only) | `partial` |
| Context chips order and removal | `src/ui/context-chip-renderer.ts#renderContextChips` | `test/ui/context-chip-renderer.test.ts#renders explicit attachments in a stable order, and no chip for the active note (U7 #4)` (unit only) | `partial` |
| Source chips and note open | `src/ui/assistant-bubble.ts#renderSourceChips` | `test/ui/chat-render.test.ts#renders deduped chips only for read-style tools and opens the note on click` | `covered` |
| Model calls the `artifact` tool (list, search, read, export) | `src/artifacts/tool-artifact-tools.ts#createArtifactTool` | `test/tool-artifact-tools.test.ts#artifact tool` (unit only) | `partial` |
| Deferred tools: `search_tools` loads a tool for the next step | `src/agent/tool-loading.ts#createSearchToolsTool` | `test/runtime-resource-state.test.ts#loads a searched tool for the next step and keeps it on later rebuilds` (unit only) | `partial` |
| Deferred tools: a direct call to an unloaded tool loads it | `src/agent/runtime-resource-state.ts#toolsForNextStep` | `test/runtime-resource-state.test.ts#loads a deferred tool after a direct call failed because it was not loaded` (unit only) | `partial` |
| Deferred tools: reopened session keeps loaded tools | `src/agent/tool-loading.ts#restoreFromMessages` | `test/runtime-resource-state.test.ts#restores the loaded tools of a reopened session from its transcript` (unit only) | `partial` |
| `current_time` tool always loaded; no date in the system prompt | `src/tools/current-time-tool.ts#createCurrentTimeTool` | `test/runtime-resource-state.test.ts#keeps the date out of the system prompt and always loads current_time` (unit only) | `partial` |
| Context ring and breakdown tooltip | `src/ui/chat-chrome.ts#syncContextRing` | `test/context-bar.test.ts#is high at 90% and above` (levels); `test/context-breakdown.test.ts#splits the system prompt, tools, and conversation; deferred tools count as 0 tokens` (breakdown) | `partial` |

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
