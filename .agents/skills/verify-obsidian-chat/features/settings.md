# Settings

## Sub-features

- Three visible tabs: Models, Agent, Advanced. Every former tab still has a
  home; no settings were deleted in the cut.
- Models: provider, global network proxy, OpenRouter privacy toggles, Ollama
  fields, OpenAI-compatible gateway fields, API keys.
- Agent: permission mode, sampling, timeout, retries, system prompt, compaction,
  tool budget, approval gates, per-tool overrides.
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
- Selectors: `.setting-item.mod-navigable` (Models, Agent, Advanced),
  `.setting-page-title`, `.agentic-chat-settings-tabbody`, `.setting-item`,
  `.checkbox-container`.
- Poll the persisted plugin settings after a change. Saves are async.
- Assert secret values through `readSecret()`, never through `data.json`.
- Moved rows live under **Advanced**. Select that tab once, then use
  `waitForSetting` for the section heading or row name.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Settings tab opens | `src/main.ts#onload` | `test/e2e/specs/settings-ui.e2e.ts#agentic-chat settings UI` (opened by the helper via `app.setting`, not the nav) | `partial` |
| Three tabs render and switch | `src/settings.ts#sectionDefinition` | `test/e2e/specs/settings-ui.e2e.ts#shows exactly three tabs and groups the advanced sections` | `covered` |
| Advanced groups web, MCP, observability, notifications, plugins, subagents, retrieval, ignore list | `src/settings.ts#sectionDefinition` | `test/e2e/specs/settings-ui.e2e.ts#agentic-chat settings UI` | `covered` |
| A moved Advanced setting saves and survives close/reopen | `src/settings-tab-agent.ts#notificationDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#keeps a moved Advanced setting after close and reopen` | `covered` |
| Models: provider, API key, base URL, model | `src/settings-tab-models.ts#modelsDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists provider, API key, base URL, and model through the Models tab` | `covered` |
| Secrets stay out of `data.json` | `src/settings-definition-kit.ts#secretInputDef` | `test/e2e/specs/settings-ui.e2e.ts#persists provider, API key, base URL, and model through the Models tab` | `covered` |
| OpenRouter privacy toggles | `src/settings-tab-models.ts#openRouterDefinitions` | no committed check | `NONE` |
| Ollama server URL and model | `src/settings-tab-models.ts#ollamaDefinitions` | no committed check | `NONE` |
| Global network proxy | `src/settings-tab-models.ts#headingRow("Network proxy")` | no committed check | `NONE` |
| Agent: Permission mode | `src/settings-tab-agent.ts#row("Permission mode"` | no committed check | `NONE` |
| Agent: sampling, timeout, retries, prompt, compaction, budget | `src/settings-tab-agent.ts#agentDefinitions` | no committed check | `NONE` |
| Approval gates: Per-tool overrides | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` | `covered` |
| Approval: working directories section removed | `src/settings-tab-agent.ts#approvalDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#removes the working-directory section and still saves approval controls` | `covered` |
| Web: enable, provider, key, results, fetch limit | `src/settings-tab-web.ts#webDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` | `covered` |
| Web: allowed hosts | `src/settings-tab-web.ts#row("Allowed hosts"` | no committed check | `NONE` |
| MCP tools: enable and add a server | `src/settings-mcp-section.ts#definitions` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| Observability with Langfuse | `src/settings-tab-web.ts#observabilityDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists observability settings through the Advanced tab` | `covered` |
| Observability: generic OTLP auth header | `src/settings-tab-web.ts#observabilityDefinitions` | `test/e2e/specs/settings-migration.e2e.ts#loads existing data.json, heals legacy fields, and migrates plaintext secrets` (migration only) | `partial` |
| Notifications section | `src/settings-tab-agent.ts#notificationDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#keeps a moved Advanced setting after close and reopen` | `covered` |
| Agent plugins: Install plugin | `src/settings-tab-plugins.ts#pluginDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| Agent plugins: Import | `src/settings-tab-plugins.ts#row("Import"` | `test/e2e/specs/settings-ui.e2e.ts#installs a plugin package from an archive URL through the Install plugin modal` | `covered` |

| Recover an interrupted plugin install | `src/plugins/service.ts#sweepImportStages` | `test/plugins-service.test.ts#restores a backup when the target is missing before sweeping` | `partial` |
| Agent plugins: Repair built-ins | `src/settings-tab-plugins.ts#pluginDefinitions` | no committed check | `NONE` |
| Agent plugins: Plugins folder | `src/settings-tab-plugins.ts#row("Plugins folder"` | `test/e2e/specs/settings-ui.e2e.ts#persists plugin folder and ignored globs through the Advanced tab` | `covered` |
| Agent plugins: plugin row toggle/open/remove | `src/settings-tab-plugins.ts#pluginRowDefinition` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the settings tab UI usable at phone width` (row renders only) | `partial` |
| Semantic retrieval: embedding controls | `src/settings-tab-retrieval.ts#retrievalDefinitions` | no committed check | `NONE` |
| Settings at phone width | `src/settings.ts#sectionDefinition` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the settings tab UI usable at phone width` | `covered` |
| `getSettingDefinitions()` | `src/settings.ts#getSettingDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#agentic-chat settings UI` (three named pages render) | `covered` |
| Settings: Request timeout (seconds) | `src/settings-tab-agent.ts#row("Request timeout (seconds)"` | `test/e2e/chaos/chaos-monkey.e2e.ts#applyPersistedSettings` (chaos run only) | `partial` |
| Settings: System prompt | `src/settings-tab-agent.ts#row("System prompt"` | `test/settings-definitions.test.ts#puts the expected surrounding rows in each section group` (definition only) | `partial` |
| Models: Gateway preset | `src/settings-tab-models.ts#row("Gateway preset"` | no committed check | `NONE` |
| Models: Context window (tokens) | `src/settings-tab-models.ts#row("Context window (tokens)"` | no committed check | `NONE` |
| Semantic retrieval: Embedding model | `src/settings-tab-retrieval.ts#row("Embedding model"` | no committed check | `NONE` |
| Semantic retrieval: Vector dimensions | `src/settings-tab-retrieval.ts#row("Vector dimensions"` | no committed check | `NONE` |
| Semantic retrieval: Batch size | `src/settings-tab-retrieval.ts#row("Batch size"` | no committed check | `NONE` |
| Semantic retrieval: Max indexed characters per note | `src/settings-tab-retrieval.ts#row("Max indexed characters per note"` | no committed check | `NONE` |
| Semantic retrieval: Ignore list | `src/settings-tab-retrieval.ts#row("Ignore list"` | `test/e2e/specs/settings-ui.e2e.ts#persists plugin folder and ignored globs through the Advanced tab` | `covered` |
| Web: Fetched page character limit | `src/settings-tab-web.ts#row("Fetched page character limit"` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` | `covered` |

## Gotchas

- The settings window is a popout, not a modal. Use the settings window handle
  for every DOM query.
- Redraws rebuild the tab body. Re-query elements after a redraw.
- Saves are async. Poll the plugin setting, do not sleep.
- Many rows are conditional. Ollama fields appear only for `ollama`, privacy
  toggles appear only for OpenRouter, and Web rows appear after the enable
  toggle. MCP and Observability rows appear after their enable toggles.
- Declarative pages replace the old horizontal tab bar. `selectSettingsTab("Advanced")`
  returns to the page list when needed, opens the Advanced page, and waits for its
  title; the old Web, MCP, Observability, Notifications, and Resources tab labels
  are gone.
- The plugin stores secret input values in Obsidian secret storage. `data.json`
  keeps only secret IDs.
- The plugin rows are in a dot-folder. Use **Open folder** to reveal them.
- See [Commands and skills](./commands-and-skills.md) for the **New skill…**
  button.
- A per-tool deny overrides the global allow policy.
