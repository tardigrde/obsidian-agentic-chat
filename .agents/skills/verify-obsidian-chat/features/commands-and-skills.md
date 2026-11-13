# Commands and skills

## Sub-features

- Slash command catalog in `src/ui/commands.ts`.
- Autocomplete menu for commands, skills, and `/skill` arguments.
- Local commands that never call the model.
- Model-facing commands that inject a prompt or control the active turn.
- Skills: built-in, plugin-provided, and bare `/skill-name` invocation.
- Skill tools: `read_skill`, `read_skill_file`, `load_skill`, `unload_skill`,
  `create_skill`.
- The New skill wizard on the Advanced settings tab (Agent plugins).
- The Repair built-ins action.

## How to get to it (user view)

- Type `/` in the composer. The autocomplete menu opens.
- Type a full command and press Enter or click **Send**.
- Type `/skill <name> [args]`, or a bare `/<skill-name> [args]`.
- Open Settings and select Agentic Chat, then open **Advanced** and find **Agent plugins**, then click
  **New skill…** or **Repair built-ins**.
- The model calls skill tools on its own. They appear as tool steps.

## Driving it with the probe harness

```ts
await browser.execute((value) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
  const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
  if (!textarea || !send) throw new Error("composer is not mounted");
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  send.click();
}, "/help");

await $(".agentic-chat-info").waitForExist();
```

- Use the send button. It takes the same `submit()` route as Enter.
- Assert the new info block text. Do not assert only that `.agentic-chat-info`
  exists.
- Skill chip: send `/skill self-knowledge probe`, then wait for a **Skill**
  summary in `.agentic-chat-info`.
- New skill: `openAgenticChatSettings()`, `selectSettingsTab("Advanced")`,
  `clickSettingButton("Import", "New skill…")`.
- `/template` has no command handler. The autocomplete detector still recognizes
  it.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/help` | `src/ui/commands.ts#name: "help"` | `test/e2e/specs/smoke.e2e.ts#runs an in-pane slash command (/help) without calling the model` | `covered` |
| `/init` | `src/ui/commands.ts#name: "init"` | `test/e2e/specs/smoke.e2e.ts#runs an in-pane slash command (/help) without calling the model` | `covered` |
| `/compact` | `src/ui/commands.ts#name: "compact"` | `test/e2e/specs/smoke.e2e.ts#clears slash commands immediately and preserves /init tail text in the transcript` | `covered` |
| `/memory` | `src/ui/commands.ts#name: "memory"` | `test/e2e/specs/smoke.e2e.ts#forgets a saved memory through the memory manager` | `covered` |
| `/status` | `src/ui/commands.ts#name: "status"` | `test/e2e/specs/runtime-behavior.e2e.ts#shows model/provider status, local undo state, and web tools when enabled` | `covered` |
| `/plan` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/e2e/specs/plan-removal.e2e.ts#out of help and the composer` | `covered` |
| `/undo` | `src/ui/commands.ts#name: "undo"` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| `/sessions` | `src/ui/commands.ts#name: "sessions"` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| `/new` | `src/ui/commands.ts#name: "new"` | `test/session-actions.test.ts#makeActions` (unit only) | `partial` |
| Alias-free command lookup | `src/ui/commands.ts#resolveCommand` | `test/commands.test.ts#does not resolve the removed working-directory commands or their aliases` (unit only) | `partial` |
| `/model` | `src/ui/commands.ts#name: "model"` | no committed check | `NONE` |
| `/style` | `src/ui/commands.ts#name: "style"` | no committed check | `NONE` |
| `/effort` | `src/ui/commands.ts#name: "effort"` | no committed check | `NONE` |
| `/usage` | `src/ui/commands.ts#name: "usage"` | no committed check | `NONE` |
| `/export` | `src/ui/commands.ts#name: "export"` | `test/session-export.test.ts#session export` (renderer only) | `partial` |
| `/semantic-index` | `src/ui/commands.ts#name: "semantic-index"` | `test/semantic-index-workflow-controller.test.ts#SemanticIndexWorkflowController` (workflow unit) | `partial` |
| Repair a stale semantic index on read | `src/retrieval/semantic-index.ts#readSemanticIndexFile` | `test/semantic-index.test.ts#repairs a stale running state on load` | `partial` |
| One semantic index writer across tabs | `src/retrieval/semantic-index.ts#acquireDurable` | `test/semantic-index-lease.test.ts#blocks a direct bootstrap call while another registry owns the path` | `partial` |
| `/doctor` | `src/ui/commands.ts#name: "doctor"` | `test/runtime-diagnostics.test.ts#runtime diagnostics` (diagnostics only) | `partial` |
| `/add-dir` and `/dirs` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts#runs an in-pane slash command (/help) without calling the model` | `covered` |
| `/agent` | `src/ui/commands.ts#name: "agent"` | `test/command-dispatcher.test.ts#resolves a named subagent with the trimmed task` (unit only) | `partial` |
| `/skill`, `/skill <name>` | `src/ui/commands.ts#name: "skill"` | `test/e2e/specs/skill-chip.e2e.ts#renders a Skill block naming the loaded skill` | `covered` |
| `/skill` with no name (picker) | `src/ui/slash/agents.ts#runSkill` | no committed check | `NONE` |
| Bare `/<skill-name>` | `src/ui/chat-view.ts#dispatchPrompt` | `test/commands.test.ts#keeps multiline argument tails for commands such as init and compact` (parse only) | `partial` |
| `/template` as a command | `src/ui/chat-view.ts#dispatchPrompt` | no handler; the word falls through to the model | `unreachable` |
| `/template <partial>` skill autocomplete | `src/ui/autocomplete.ts#detectQuery` | `test/autocomplete.test.ts#treats /template like /skill for arg completion` (unit only) | `partial` |
| Autocomplete menu for commands | `src/ui/chat-view.ts#updateAutocomplete` | `test/e2e/specs/autocomplete-dropup.e2e.ts#renders the /sta menu above the input card, fully visible` | `covered` |
| Autocomplete keyboard keys | `src/ui/autocomplete-menu.ts#handleKey` | no committed check | `NONE` |
| Built-in skills are available | `src/skills/builtin-skills.ts#builtinSkills` | `test/builtin-skills.test.ts#builtinSkills` (catalog only) | `partial` |
| Plugin skills load with built-ins | `src/agent/runtime-resources.ts#loadAgentRuntimeResources` | `test/runtime-resources.test.ts#composes the system prompt from a loaded resource snapshot` (unit only) | `partial` |
| `read_skill` | `src/tools/read-skill-tool.ts#createReadSkillTool` | `test/read-skill-tool.test.ts#createReadSkillTool` (unit only) | `partial` |
| `read_skill_file` | `src/tools/read-skill-tool.ts#createReadSkillFileTool` | no committed check | `NONE` |
| `load_skill` | `src/tools/skill-tools.ts#requireSkill` | no committed check | `NONE` |
| `unload_skill` | `src/tools/skill-tools.ts#createLoadSkillTool` | no committed check | `NONE` |
| `create_skill` | `src/tools/skill-tools.ts#SkillScaffolder` | `test/skill-create-tool.test.ts#create_skill tool` (unit only) | `partial` |
| New skill modal | `src/ui/new-skill-modal.ts#onOpen` | no committed check | `NONE` |
| Repair built-ins | `src/settings-tab-plugins.ts#pluginDefinitions` | no committed check | `NONE` |
| Unregistered compat tools (`ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties`) | `src/tools/vault-tools.ts#createVaultTools` | no production caller passes `surface: "compat"`; the default surface filters these out at `src/tools/tool-contracts.ts#DEFAULT_BUILTIN_TOOL_CONTRACTS` | `unreachable` |

## Gotchas

- Composer delivery is not a slash command. Enter sends or steers, Shift+Enter
  adds a newline, Queue holds a draft, and Stop then send replaces the turn.
- A built-in command wins over a skill with the same name. Use `/skill <name>`
  to reach the shadowed skill.
- Local commands must not hit the network. Assert both the info block and the
  absence of a model call.
- `/init` keeps the full command text in the transcript and clears the composer.
- `/compact` accepts tail instructions. The tail guides the summary.
- `/template` has no command handler. It only triggers skill-argument
  autocomplete.
- The approval modal cannot remember approvals for `create_skill`, `load_skill`,
  or `unload_skill`.
- The `.agentic-chat-info` element may exist from an earlier command. Assert the
  new text.
