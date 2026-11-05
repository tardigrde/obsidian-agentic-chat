# Commands and skills

## Sub-features

- Slash command catalog and aliases in `src/ui/commands.ts`.
- Autocomplete menu for commands, skills, and `/skill` arguments.
- Local commands that never call the model.
- Model-facing commands that inject a prompt or control the active turn.
- Hidden or retired commands: `/project`.
- Skills: built-in, plugin-provided, and bare `/skill-name` invocation.
- Skill tools: `read_skill`, `read_skill_file`, `load_skill`, `unload_skill`,
  `create_skill`.
- New skill wizard in Settings → Resources.
- Repair built-ins action.

## How to get to it (user POV)

- Type `/` in the composer. The autocomplete menu opens.
- Type a full command and press Enter or click **Send**.
- Type `/skill <name> [args]`, or a bare `/<skill-name> [args]`.
- Settings → Agentic Chat → **Resources** → **New skill…** or **Repair
  built-ins**.
- The model calls skill tools on its own; they appear as tool steps.

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
- Assert the new info block text, not only `.agentic-chat-info` existence.
- Skill chip: send `/skill self-knowledge probe`, then wait for a **Skill**
  summary in `.agentic-chat-info`.
- New skill: `openAgenticChatSettings()`, `selectSettingsTab("Resources")`,
  `clickSettingButton("Import", "New skill…")`.
- `/template` has no routing. It only appears in autocomplete detection.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| `/help` | `src/ui/commands.ts:56` | `test/e2e/specs/smoke.e2e.ts:51` | `covered` |
| `/init` | `src/ui/commands.ts:52` | `test/e2e/specs/smoke.e2e.ts:58` | `covered` |
| `/compact` | `src/ui/commands.ts:47` | `test/e2e/specs/smoke.e2e.ts:72` | `covered` |
| `/dirs` | `src/ui/commands.ts:38` | `test/e2e/specs/smoke.e2e.ts:91` | `covered` |
| `/memory` | `src/ui/commands.ts:33` | `test/e2e/specs/smoke.e2e.ts:132` | `covered` |
| `/todo` | `src/ui/commands.ts:40` | `test/e2e/specs/smoke.e2e.ts:208` | `covered` |
| `/status` | `src/ui/commands.ts:32` | `test/e2e/specs/runtime-behavior.e2e.ts:220` | `covered` |
| `/plan` | `src/ui/commands.ts:39` | `test/e2e/specs/runtime-behavior.e2e.ts:220` | `covered` |
| `/undo` | `src/ui/commands.ts:49` | `test/e2e/specs/approval-deterministic.e2e.ts:261` | `covered` |
| `/steer` | `src/ui/commands.ts:41` | `test/e2e/specs/approval-deterministic.e2e.ts:436` | `covered` |
| `/sessions` | `src/ui/commands.ts:30` | `test/e2e/specs/runtime-behavior.e2e.ts:163` | `covered` |
| `/new` | `src/ui/commands.ts:29` | `test/session-actions.test.ts:153` (unit only) | `partial` |
| `/model` | `src/ui/commands.ts:31` | no committed check | `NONE` |
| `/config` | `src/ui/commands.ts:36` | no committed check | `NONE` |
| `/style` | `src/ui/commands.ts:44` | no committed check | `NONE` |
| `/effort` | `src/ui/commands.ts:45` | no committed check | `NONE` |
| `/usage` | `src/ui/commands.ts:46` | no committed check | `NONE` |
| `/follow-up` | `src/ui/commands.ts:42` | `test/turn-control.test.ts:98` (parser and label only) | `partial` |
| `/redirect` | `src/ui/commands.ts:43` | `test/turn-control.test.ts:98` (parser and label only) | `partial` |
| `/export` | `src/ui/commands.ts:48` | `test/session-export.test.ts:31` (renderer only) | `partial` |
| `/semantic-index` | `src/ui/commands.ts:34` | `test/semantic-index-workflow-controller.test.ts:85` (workflow unit) | `partial` |
| `/doctor` | `src/ui/commands.ts:35` | `test/runtime-diagnostics.test.ts:13` (diagnostics only) | `partial` |
| `/add-dir` | `src/ui/commands.ts:37` | `test/working-directory-workflow-controller.test.ts:69` (unit only) | `partial` |
| `/agent` | `src/ui/commands.ts:51` | `test/command-dispatcher.test.ts:54` (unit only) | `partial` |
| `/skill <name>` | `src/ui/commands.ts:50` | `test/e2e/specs/skill-chip.e2e.ts:22` | `covered` |
| `/skill` with no name (picker) | `src/ui/chat-view.ts:1820` | no committed check | `NONE` |
| Bare `/<skill-name>` | `src/ui/chat-view.ts:1604` | `test/commands.test.ts:81` (parse only) | `partial` |
| Hidden `/project` redirect | `src/ui/commands.ts:55` | no committed check | `NONE` |
| `/template` as a command | `src/ui/chat-view.ts:1601` | no handler; the word falls through to the model | `unreachable` |
| `/template <partial>` skill autocomplete | `src/ui/autocomplete.ts:77` | `test/autocomplete.test.ts:42` | `covered` |
| Autocomplete menu for commands | `src/ui/chat-view.ts:953` | `test/e2e/specs/autocomplete-dropup.e2e.ts:34` | `covered` |
| Autocomplete keyboard keys | `src/ui/autocomplete-menu.ts:108` | no committed check | `NONE` |
| Built-in skills are available | `src/skills/builtin-skills.ts:202` | `test/builtin-skills.test.ts:4` (catalog only) | `partial` |
| Plugin skills load with built-ins | `src/agent/runtime-resources.ts:81` | `test/runtime-resources.test.ts:126` (unit only) | `partial` |
| `read_skill` | `src/tools/read-skill-tool.ts:37` | `test/read-skill-tool.test.ts:5` | `covered` |
| `read_skill_file` | `src/tools/read-skill-tool.ts:71` | no committed check | `NONE` |
| `load_skill` | `src/tools/skill-tools.ts:35` | no committed check | `NONE` |
| `unload_skill` | `src/tools/skill-tools.ts:68` | no committed check | `NONE` |
| `create_skill` | `src/tools/skill-tools.ts:124` | `test/skill-create-tool.test.ts:21` | `covered` |
| New skill modal | `src/ui/new-skill-modal.ts:34` | no committed check | `NONE` |
| Repair built-ins | `src/settings.ts:2069` | no committed check | `NONE` |
| Unregistered compat tools (`ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties`) | `src/tools/vault-tools.ts:68` | no production caller passes `surface: "compat"`; the default surface filters these out at `src/tools/tool-contracts.ts:305` | `unreachable` |

## Gotchas

- A built-in command wins over a skill with the same name. Use `/skill <name>`
  to reach the shadowed skill.
- Local commands must not hit the network. Assert the absence of a model call,
  not only the info block.
- `/init` keeps the full command text in the transcript and clears the composer.
- `/compact` accepts tail instructions; the tail guides the summary.
- `/plan` is sticky. Pair it with an exit action in the same scenario.
- `/project` is hidden but still routable. It renders a removal notice.
- `/template` is dead as a command. It only triggers skill-argument
  autocomplete.
- `load_skill`, `unload_skill`, and create/load/unload approvals cannot be
  remembered.
- The `.agentic-chat-info` element may exist from an earlier command. Assert the
  new text.
