# Commands and skills

## Sub-features

- Slash command catalog in `src/ui/commands.ts`.
- Autocomplete menu for commands, skills, and `/skill` arguments.
- Local commands that never call the model.
- Model-facing commands that inject a prompt or control the active turn.
- Skills: built-in, plugin-provided, and bare `/skill-name` invocation.
- Skill tool: `skill` (actions `read` and `read_file`, always loaded). There is
  no model-facing skill writer; skills are created in the New skill wizard.
- The New skill wizard on the Advanced settings tab (Agent plugins).
- Built-in skills served from code (no vault copy); a vault skill of the same name overrides.

## How to get to it (user view)

- Type `/` in the composer. The autocomplete menu opens.
- Type a full command and press Enter or click **Send**.
- Type `/skill <name> [args]`, or a bare `/<skill-name> [args]`.
- Open Settings and select Agentic Chat, then open **Advanced** and find **Agent plugins**, then click
  **New skill…**.
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

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/help` | `src/ui/commands.ts#name: "help"` | `test/e2e/specs/smoke.e2e.ts#routes /help, /init, and /compact locally without a model call` | `covered` |
| `/init` | `src/ui/commands.ts#name: "init"` | `test/e2e/specs/smoke.e2e.ts#routes /help, /init, and /compact locally without a model call` | `covered` |
| `/compact` | `src/ui/commands.ts#name: "compact"` | `test/e2e/specs/smoke.e2e.ts#routes /help, /init, and /compact locally without a model call` | `covered` |
| `/memory` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/feature-cut-2026-11.test.ts#does not register /memory and shows a retired hint` (unit only) | `partial` |
| `/plan` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/e2e/specs/smoke.e2e.ts#renders a scripted turn, answers /plan locally, runs /skill, and Stop clears a running turn` | `covered` |
| `/undo` | `src/ui/commands.ts#name: "undo"` | `test/e2e/specs/approval-deterministic.e2e.ts#asks before a scripted edit and undo restores the prior text` | `covered` |
| `/sessions` | `src/ui/commands.ts#name: "sessions"` | `test/e2e/specs/runtime-behavior.e2e.ts#reopens, renames, and deletes persisted sessions without a model call` | `covered` |
| `/new` | `src/ui/commands.ts#name: "new"` | `test/session-actions.test.ts#makeActions` (unit only) | `partial` |
| Alias-free command lookup | `src/ui/commands.ts#resolveCommand` | `test/commands.test.ts#does not resolve the removed working-directory commands or their aliases` (unit only) | `partial` |
| `/model` | `src/ui/commands.ts#name: "model"` | no committed check | `NONE` |
| `/style` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/feature-cut-2026-11.test.ts#does not register /style and shows a retired hint` (unit only) | `partial` |
| `/effort` | `src/ui/commands.ts#name: "effort"` | no committed check | `NONE` |
| `/usage` | `src/ui/commands.ts#name: "usage"` | no committed check | `NONE` |
| `/export` | `src/ui/commands.ts#name: "export"` | `test/session-export.test.ts#session export` (renderer only) | `partial` |
| `import_pdf` tool removed | `src/tools/document-tools.ts#createDocumentTools` | `test/feature-cut-2026-11.test.ts#does not give the model the import_pdf alias` (unit only) | `partial` |
| `/semantic-index` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/feature-cut-2026-11.test.ts#does not register /semantic-index and shows a retired hint` (unit only) | `partial` |
| `/doctor` | `src/ui/commands.ts#name: "doctor"`; `src/agent/doctor-report.ts#buildDoctorReport` | `test/ui/doctor.test.ts#shows the status first, closed sections with counts, and saves a diagnostics entry for the miner`; `test/doctor-report.test.ts#lists problems first, each with a fix: a failed plugin, a failing MCP server, a stale catalog` | `partial` |
| `/add-dir` and `/dirs` removed | `src/ui/commands.ts#SLASH_COMMANDS` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts#routes /help, /init, and /compact locally without a model call` | `covered` |
| `/agent` | `src/ui/commands.ts#name: "agent"` | `test/command-dispatcher.test.ts#resolves a named subagent with the trimmed task` (unit only) | `partial` |
| `/skill`, `/skill <name>` | `src/ui/commands.ts#name: "skill"` | `test/e2e/specs/smoke.e2e.ts#renders a scripted turn, answers /plan locally, runs /skill, and Stop clears a running turn` | `covered` |
| `/skill` with no name (picker) | `src/ui/slash/agents.ts#runSkill` | no committed check | `NONE` |
| Bare `/<skill-name>` | `src/ui/chat-turn.ts#dispatchPrompt` | `test/commands.test.ts#keeps multiline argument tails for commands such as init and compact` (parse only) | `partial` |
| Unknown `/word` shows "Unknown command", no model call | `src/ui/chat-actions.ts#showUnknownCommandHint` | `test/e2e/specs/slash-unknown-command.e2e.ts#shows a hint for an unknown command and does not send it to the model` | `covered` |
| Autocomplete menu for commands | `src/ui/composer-controller.ts#updateAutocomplete` | `test/e2e/specs/smoke.e2e.ts#renders the /sta autocomplete menu above the input card, fully visible` | `covered` |
| Autocomplete keyboard keys | `src/ui/autocomplete-menu.ts#handleKey` | no committed check | `NONE` |
| Built-in skills are available | `src/skills/builtin-skills.ts#builtinSkills` | `test/builtin-skills.test.ts#builtinSkills` (catalog only) | `partial` |
| Plugin skills load with built-ins | `src/agent/runtime-resources.ts#loadAgentRuntimeResources` | `test/runtime-resources.test.ts#composes the system prompt from a loaded resource snapshot` (unit only) | `partial` |
| `skill` tool, action `read` | `src/tools/skill-tool.ts#createSkillTool` | `test/skill-tool.test.ts#skill tool: action read` (unit only) | `partial` |
| `skill` tool, action `read_file` | `src/tools/skill-tool.ts#readSkillFile` | `test/skill-tool.test.ts#skill tool: action read_file` (unit only) | `partial` |
| Retired `read_skill`, `read_skill_file`, `load_skill`, `unload_skill` tools | `src/agent/runtime-resources.ts#buildAgentParentTools` | `test/feature-cut-2026-11.test.ts#feature cut 2026-11: tool consolidation` (unit only) | `partial` |
| `create_skill` removed | `src/ui/new-skill-modal.ts#onOpen` | `test/ui/chat-render.test.ts#renders an old session's removed create_skill call with the generic tool name`; `test/settings-definitions.test.ts#keys every per-tool approval row by a real catalog tool and shows its real default` | `partial` |
| New skill modal | `src/ui/new-skill-modal.ts#onOpen` | no committed check | `NONE` |
| Built-in skills served from code, never copied to the vault | `src/skills/builtin-skills.ts#builtinSkills` | `test/plugins-service-import.test.ts#the plugin never writes a builtins package to the vault` (unit only) | `partial` |
| Retired standalone inspect tools (`ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties`) | `src/tools/tool-contracts.ts#BUILTIN_TOOL_NAMES` | `test/tool-contracts.test.ts#drives tool registration order; the old standalone inspect tools are gone` (unit only) | `partial` |

## Gotchas

- Composer delivery is not a slash command. Enter sends or steers, Shift+Enter
  adds a newline, Queue holds a draft, and Stop then send replaces the turn.
- A built-in command wins over a skill with the same name. Use `/skill <name>`
  to reach the shadowed skill.
- Local commands must not hit the network. Assert both the info block and the
  absence of a model call.
- `/init` keeps the full command text in the transcript and clears the composer.
- `/compact` accepts tail instructions. The tail guides the summary.
- An unknown `/word` (a letter, then letters, digits, `-`, `_`, `.`) shows
  "Unknown command" and makes no model call. Text with a `/` after the first
  word, such as a path, still goes to the model.
- The New skill wizard is the only way the model/UI creates a skill package;
  there is no `create_skill` tool to remember an approval for.
- The `.agentic-chat-info` element may exist from an earlier command. Assert the
  new text.
