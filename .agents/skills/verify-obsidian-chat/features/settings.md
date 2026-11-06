# Settings

## Sub-features

- Eight tabs: Models, Agent, Approval, Web, MCP, Observability, Notifications,
  Resources.
- Models: provider, global network proxy, OpenRouter privacy toggles, Ollama
  fields, OpenAI-compatible gateway fields, API keys.
- Agent: permission mode, sampling, timeout, retries, system prompt, compaction,
  tool budget.
- Approval: global gate, per-tool overrides, working directories.
- Web: enable, search provider, key or SearXNG URL, result count, fetch limit,
  allowed hosts.
- MCP: enable, server packages, auth, tool filters, tool approvals, setup guide.
- Observability: backend, endpoint, payload detail, sample rate, proxy, Langfuse
  keys or generic OTLP auth header.
- Notifications: background toasts, cost alert, hard spend cap.
- Resources: install plugin, New skill, Repair built-ins, plugins folder, plugin
  rows, subagent timeout, embeddings, ignore list.
- The plugin stores secrets in Obsidian secret storage, not in `data.json`.

## How to get to it (user view)

- In Obsidian, open Settings and select **Agentic Chat** in the left navigation.
- Programmatically: `app.setting.open(); app.setting.openTabById("agentic-chat")`.
- The plugin does not add its own "open settings" command. Obsidian's Settings
  command opens the settings window. Then select the Agentic Chat tab.
- On Obsidian 1.13 and later, the tab opens in a popout window.

## Driving it with the probe harness

```ts
await openAgenticChatSettings();
await selectSettingsTab("Approval");
await setSettingSelect("Write file", "ask");
await closeAgenticChatSettings();
```

- Use `test/e2e/support/settings-ui.ts`. It tracks the main and popout handles.
- Selectors: `.agentic-chat-settings-tabs`, `.agentic-chat-settings-tab`,
  `.agentic-chat-settings-tabbody`, `.setting-item`, `.checkbox-container`.
- Poll the persisted plugin settings after a change. Saves are async.
- Assert secret values through `readSecret()`, never through `data.json`.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Settings tab opens | `src/main.ts:107` | `test/e2e/specs/settings-ui.e2e.ts:180` (opened by the helper via `app.setting`, not the nav) | `partial` |
| Tabs render and switch | `src/settings.ts:223` | `test/e2e/specs/settings-ui.e2e.ts:180` | `covered` |
| Models: provider, API key, base URL, model | `src/settings.ts:386` | `test/e2e/specs/settings-ui.e2e.ts:180` | `covered` |
| Secrets stay out of `data.json` | `src/settings.ts:1992` | `test/e2e/specs/settings-ui.e2e.ts:180` | `covered` |
| OpenRouter privacy toggles | `src/settings.ts:471` | no committed check | `NONE` |
| Ollama server URL and model | `src/settings.ts:503` | no committed check | `NONE` |
| Global network proxy | `src/settings.ts:393` | no committed check | `NONE` |
| Agent: permission mode dropdown | `src/settings.ts:611` | no committed check | `NONE` |
| Agent: sampling, timeout, retries, prompt, compaction, budget | `src/settings.ts:608` | no committed check | `NONE` |
| Approval gates and per-tool overrides | `src/settings.ts:746` | `test/e2e/specs/settings-ui.e2e.ts:221` | `covered` |
| Approval: working directories row | `src/settings.ts:795` | no committed check | `NONE` |
| Web: enable, provider, key, results, fetch limit | `src/settings.ts:842` | `test/e2e/specs/settings-ui.e2e.ts:232` | `covered` |
| Web: allowed hosts | `src/settings.ts:941` | no committed check | `NONE` |
| MCP tab | `src/settings.ts:960` | `test/e2e/specs/settings-ui.e2e.ts:268` | `covered` |
| Observability with Langfuse | `src/settings.ts:1069` | `test/e2e/specs/settings-ui.e2e.ts:394` | `covered` |
| Observability: generic OTLP auth header | `src/settings.ts:1190` | `test/e2e/specs/settings-migration.e2e.ts:199` (migration only) | `partial` |
| Notifications tab | `src/settings.ts:1997` | no committed check | `NONE` |
| Resources: Install plugin | `src/settings.ts:2051` | `test/e2e/specs/settings-ui.e2e.ts:311` | `covered` |
| Recover an interrupted plugin install | `src/plugins/service.ts:556` | `test/plugins-service.test.ts:109` | `partial` |
| Resources: Repair built-ins | `src/settings.ts:2069` | no committed check | `NONE` |
| Resources: plugins folder and ignore list | `src/settings.ts:2082` | `test/e2e/specs/settings-ui.e2e.ts:435` | `covered` |
| Resources: plugin row toggle/open/remove | `src/settings.ts:2271` | `test/e2e/specs/mobile-viewport.e2e.ts:404` (row renders only) | `partial` |
| Resources: subagent timeout | `src/settings.ts:2098` | no committed check | `NONE` |
| Resources: embedding controls | `src/settings.ts:2116` | no committed check | `NONE` |
| Settings at phone width | `src/settings.ts:356` | `test/e2e/specs/mobile-viewport.e2e.ts:404` | `covered` |
| `getSettingDefinitions()` | `src/settings.ts:214` | returns `[]`; rendering goes through `display()` | `unreachable` |

## Gotchas

- The settings window is a popout, not a modal. Use the settings window handle
  for every DOM query.
- Redraws rebuild the tab body. Re-query elements after a redraw.
- Saves are async. Poll the plugin setting, do not sleep.
- Many rows are conditional. Ollama fields appear only for `ollama`, privacy
  toggles appear only for OpenRouter, and Web rows appear after the enable
  toggle. MCP and Observability rows appear after their enable toggles.
- The plugin stores secret input values in Obsidian secret storage. `data.json`
  keeps only secret IDs.
- `getSettingDefinitions()` is a stub that returns `[]`. It is not a working
  declarative-settings path.
- The plugin rows are in a dot-folder. Use **Open folder** to reveal them.
- See [Commands and skills](./commands-and-skills.md) for the **New skill…**
  button.
- A per-tool deny overrides the global allow policy.
