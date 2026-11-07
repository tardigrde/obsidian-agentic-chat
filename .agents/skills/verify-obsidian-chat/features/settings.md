# Settings

## Sub-features

- Three visible tabs: Models, Agent, Advanced. Every former tab still has a
  home; no settings were deleted in the cut.
- Models: provider, global network proxy, OpenRouter privacy toggles, Ollama
  fields, OpenAI-compatible gateway fields, API keys.
- Agent: permission mode, sampling, timeout, retries, system prompt, compaction,
  tool budget, approval gates, per-tool overrides, working directories.
- Advanced: web access, MCP, observability, notifications, agent plugins,
  subagents, semantic retrieval, ignored files.
- The plugin stores secrets in Obsidian secret storage, not in `data.json`.

## How to get to it (user view)

- In Obsidian, open Settings and select **Agentic Chat** in the left navigation.
- Programmatically: `app.setting.open(); app.setting.openTabById("agentic-chat")`.
- The plugin does not add its own "open settings" command. Obsidian's Settings
  command opens the settings window. Then select the Agentic Chat tab.
- On Obsidian 1.13 and later, the tab opens in a popout window.
- Advanced renders its sections on one page in this order: web access, MCP,
  observability, notifications, agent plugins, subagents, semantic retrieval,
  ignored files.

## Driving it with the probe harness

```ts
await openAgenticChatSettings();
await selectSettingsTab("Agent");
await setSettingSelect("Write file", "ask");
await closeAgenticChatSettings();
```

- Use `test/e2e/support/settings-ui.ts`. It tracks the main and popout handles.
- Selectors: `.agentic-chat-settings-tabs`, `.agentic-chat-settings-tab`,
  `.agentic-chat-settings-tabbody`, `.setting-item`, `.checkbox-container`.
- Poll the persisted plugin settings after a change. Saves are async.
- Assert secret values through `readSecret()`, never through `data.json`.
- Moved rows live under **Advanced**. Select that tab once, then use
  `waitForSetting` for the section heading or row name.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Settings tab opens | `src/main.ts:129` | `test/e2e/specs/settings-ui.e2e.ts:183` (opened by the helper via `app.setting`, not the nav) | `partial` |
| Three tabs render and switch | `src/settings.ts:374` | `test/e2e/specs/settings-ui.e2e.ts:183` | `covered` |
| Advanced groups web, MCP, observability, notifications, plugins, subagents, retrieval, ignore list | `src/settings.ts:381` | `test/e2e/specs/settings-ui.e2e.ts:183` | `covered` |
| A moved Advanced setting saves and survives close/reopen | `src/settings.ts:2028` | `test/e2e/specs/settings-ui.e2e.ts:483` | `covered` |
| Models: provider, API key, base URL, model | `src/settings.ts:401` | `test/e2e/specs/settings-ui.e2e.ts:218` | `covered` |
| Secrets stay out of `data.json` | `src/settings.ts:1980` | `test/e2e/specs/settings-ui.e2e.ts:218` | `covered` |
| OpenRouter privacy toggles | `src/settings.ts:496` | no committed check | `NONE` |
| Ollama server URL and model | `src/settings.ts:526` | no committed check | `NONE` |
| Global network proxy | `src/settings.ts:420` | no committed check | `NONE` |
| Agent: permission mode dropdown | `src/settings.ts:636` | no committed check | `NONE` |
| Agent: sampling, timeout, retries, prompt, compaction, budget | `src/settings.ts:632` | no committed check | `NONE` |
| Approval gates and per-tool overrides | `src/settings.ts:770` | `test/e2e/specs/settings-ui.e2e.ts:259` | `covered` |
| Approval: working directories row | `src/settings.ts:820` | no committed check | `NONE` |
| Web: enable, provider, key, results, fetch limit | `src/settings.ts:866` | `test/e2e/specs/settings-ui.e2e.ts:270` | `covered` |
| Web: allowed hosts | `src/settings.ts:966` | no committed check | `NONE` |
| MCP tools: enable and add a server | `src/settings.ts:984` | `test/e2e/specs/settings-ui.e2e.ts:306` | `covered` |
| Observability with Langfuse | `src/settings.ts:1088` | `test/e2e/specs/settings-ui.e2e.ts:432` | `covered` |
| Observability: generic OTLP auth header | `src/settings.ts:1215` | `test/e2e/specs/settings-migration.e2e.ts:199` (migration only) | `partial` |
| Notifications section | `src/settings.ts:2028` | `test/e2e/specs/settings-ui.e2e.ts:483` | `covered` |
| Agent plugins: Install plugin | `src/settings.ts:2083` | `test/e2e/specs/settings-ui.e2e.ts:349` | `covered` |
| Recover an interrupted plugin install | `src/plugins/service.ts:597` | `test/plugins-service.test.ts:109` | `partial` |
| Agent plugins: Repair built-ins | `src/settings.ts:2102` | no committed check | `NONE` |
| Agent plugins: folder, ignored files | `src/settings.ts:2113` | `test/e2e/specs/settings-ui.e2e.ts:473` | `covered` |
| Agent plugins: plugin row toggle/open/remove | `src/settings.ts:2308` | `test/e2e/specs/mobile-viewport.e2e.ts:404` (row renders only) | `partial` |
| Subagents: timeout | `src/settings.ts:2133` | no committed check | `NONE` |
| Semantic retrieval: embedding controls | `src/settings.ts:2153` | no committed check | `NONE` |
| Settings at phone width | `src/settings.ts:381` | `test/e2e/specs/mobile-viewport.e2e.ts:404` | `covered` |
| `getSettingDefinitions()` | `src/settings.ts:215` | returns `[]`; rendering goes through `display()` | `unreachable` |

## Gotchas

- The settings window is a popout, not a modal. Use the settings window handle
  for every DOM query.
- Redraws rebuild the tab body. Re-query elements after a redraw.
- Saves are async. Poll the plugin setting, do not sleep.
- Many rows are conditional. Ollama fields appear only for `ollama`, privacy
  toggles appear only for OpenRouter, and Web rows appear after the enable
  toggle. MCP and Observability rows appear after their enable toggles.
- Advanced is one long page, not nested tabs. `selectSettingsTab("Advanced")`
  then `waitForSetting(...)`; the old Web, MCP, Observability, Notifications, and
  Resources tab labels are gone.
- The plugin stores secret input values in Obsidian secret storage. `data.json`
  keeps only secret IDs.
- `getSettingDefinitions()` is a stub that returns `[]`. It is not a working
  declarative-settings path.
- The plugin rows are in a dot-folder. Use **Open folder** to reveal them.
- See [Commands and skills](./commands-and-skills.md) for the **New skill…**
  button.
- A per-tool deny overrides the global allow policy.
