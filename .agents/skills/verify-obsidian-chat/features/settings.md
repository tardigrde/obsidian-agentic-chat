# Settings

## Sub-features

- Tabs: Models, Agent, Approval, Web, MCP, Observability, Notifications, Resources.
- Provider, base URL, model, and API key.
- Approval policy: global allow/ask/deny, per-tool overrides, working directories.
- Web search and fetch allowlist.
- MCP servers, skills, observability export.
- Secrets are stored outside `data.json` in Obsidian secret storage.

## How to get to it (user POV)

- Obsidian Settings, then the `Agentic Chat` tab.
- Command palette: `Settings`.
- Programmatically:
  `app.setting.open(); app.setting.openTabById("agentic-chat")`.
- On Obsidian 1.13+ the settings open in a **popout window**.

## Driving it with the probe harness

Use `test/e2e/support/settings-ui.ts`; it tracks both window handles.

```ts
await openAgenticChatSettings();
await selectSettingsTab("Approval");
await setSettingSelect("Write file", "allow");
await closeAgenticChatSettings();
```

Selectors: `.agentic-chat-settings-tabs`, `.agentic-chat-settings-tab`,
`.agentic-chat-settings-tabbody`, `.setting-item`, `.checkbox-container`.

The per-tool setting name is the tool label, for example `Write file`, `Edit file`,
`Delete file or folder`.

Committed proof: `test/e2e/specs/settings-ui.e2e.ts`,
`test/e2e/specs/settings-migration.e2e.ts`.

## Gotchas

- Popout, not modal. Every DOM query must run in the settings window handle.
- Saves are async. After a change, poll the plugin settings value instead of
  sleeping.
- `deny` wins over `allow` at every layer. Per-tool overrides beat the global
  policy, and approval memory writes into the same `perTool` map.
- Changing provider or model can invalidate a cached request path. Re-read the
  effective settings, not the form values.
- Secrets never appear in `data.json`. Do not assert on plaintext keys there; check
  the secret store reference instead.
