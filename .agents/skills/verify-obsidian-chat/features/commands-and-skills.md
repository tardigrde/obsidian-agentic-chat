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
| `/help` | `src/ui/commands.ts:42` | `test/e2e/specs/smoke.e2e.ts:51` | `covered` |
| `/init` | `src/ui/commands.ts:41` | `test/e2e/specs/smoke.e2e.ts:59` | `covered` |
| `/compact` | `src/ui/commands.ts:36` | `test/e2e/specs/smoke.e2e.ts:73` | `covered` |
| `/memory` | `src/ui/commands.ts:30` | `test/e2e/specs/smoke.e2e.ts:135` | `covered` |
| `/status` | `src/ui/commands.ts:29` | `test/e2e/specs/runtime-behavior.e2e.ts:228` | `covered` |
| `/plan` removed | `src/ui/commands.ts:25` | `test/e2e/specs/plan-removal.e2e.ts:67` | `covered` |
| `/undo` | `src/ui/commands.ts:38` | `test/e2e/specs/approval-deterministic.e2e.ts:253` | `covered` |
| `/sessions` | `src/ui/commands.ts:27` | `test/e2e/specs/runtime-behavior.e2e.ts:165` | `covered` |
| `/new` | `src/ui/commands.ts:26` | `test/session-actions.test.ts:153` (unit only) | `partial` |
| Alias-free command lookup | `src/ui/commands.ts:56` | `test/commands.test.ts:62` (unit only) | `partial` |
| `/model` | `src/ui/commands.ts:28` | no committed check | `NONE` |
| `/style` | `src/ui/commands.ts:33` | no committed check | `NONE` |
| `/effort` | `src/ui/commands.ts:34` | no committed check | `NONE` |
| `/usage` | `src/ui/commands.ts:35` | no committed check | `NONE` |
| `/export` | `src/ui/commands.ts:37` | `test/session-export.test.ts:31` (renderer only) | `partial` |
| `/semantic-index` | `src/ui/commands.ts:31` | `test/semantic-index-workflow-controller.test.ts:85` (workflow unit) | `partial` |
| Repair a stale semantic index on read | `src/retrieval/semantic-index.ts:403` | `test/semantic-index.test.ts:90` | `partial` |
| One semantic index writer across tabs | `src/retrieval/semantic-index.ts:201` | `test/semantic-index-lease.test.ts:81` | `partial` |
| `/doctor` | `src/ui/commands.ts:32` | `test/runtime-diagnostics.test.ts:13` (diagnostics only) | `partial` |
| `/add-dir` and `/dirs` removed | `src/ui/commands.ts:25` | `test/commands.test.ts` (unit) plus `/help` absence in `test/e2e/specs/smoke.e2e.ts:51` | `covered` |
| `/agent` | `src/ui/commands.ts:40` | `test/command-dispatcher.test.ts:54` (unit only) | `partial` |
| `/skill <name>` | `src/ui/commands.ts:39` | `test/e2e/specs/skill-chip.e2e.ts:22` | `covered` |
| `/skill` with no name (picker) | `src/ui/chat-view.ts:1700` | no committed check | `NONE` |
| Bare `/<skill-name>` | `src/ui/chat-view.ts:1447` | `test/commands.test.ts:94` (parse only) | `partial` |
| `/template` as a command | `src/ui/chat-view.ts:1447` | no handler; the word falls through to the model | `unreachable` |
| `/template <partial>` skill autocomplete | `src/ui/autocomplete.ts:77` | `test/autocomplete.test.ts:42` (unit only) | `partial` |
| Autocomplete menu for commands | `src/ui/chat-view.ts:890` | `test/e2e/specs/autocomplete-dropup.e2e.ts:34` | `covered` |
| Autocomplete keyboard keys | `src/ui/autocomplete-menu.ts:108` | no committed check | `NONE` |
| Built-in skills are available | `src/skills/builtin-skills.ts:202` | `test/builtin-skills.test.ts:4` (catalog only) | `partial` |
| Plugin skills load with built-ins | `src/agent/runtime-resources.ts:81` | `test/runtime-resources.test.ts:126` (unit only) | `partial` |
| `read_skill` | `src/tools/read-skill-tool.ts:37` | `test/read-skill-tool.test.ts:5` (unit only) | `partial` |
| `read_skill_file` | `src/tools/read-skill-tool.ts:71` | no committed check | `NONE` |
| `load_skill` | `src/tools/skill-tools.ts:35` | no committed check | `NONE` |
| `unload_skill` | `src/tools/skill-tools.ts:68` | no committed check | `NONE` |
| `create_skill` | `src/tools/skill-tools.ts:124` | `test/skill-create-tool.test.ts:21` (unit only) | `partial` |
| New skill modal | `src/ui/new-skill-modal.ts:36` | no committed check | `NONE` |
| Repair built-ins | `src/settings.ts:1175` | no committed check | `NONE` |
| Unregistered compat tools (`ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties`) | `src/tools/vault-tools.ts:76` | no production caller passes `surface: "compat"`; the default surface filters these out at `src/tools/tool-contracts.ts:305` | `unreachable` |

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
