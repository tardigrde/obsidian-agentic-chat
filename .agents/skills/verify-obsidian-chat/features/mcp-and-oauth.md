# MCP and OAuth

## Sub-features

- MCP master toggle and MCP-only proxy override.
- Add an HTTPS MCP server; the plugin writes a real Agent Plugins package.
- Server row: enable, approval policy, test/refresh, OAuth sign-in.
- Auth modes: none, bearer token, static header, OAuth.
- OAuth discovery, dynamic client registration, PKCE, desktop loopback callback,
  mobile Obsidian protocol callback, token refresh.
- Tool allowlist/denylist and per-tool approvals.
- Plugin-provided MCP servers, imported disabled by default.
- Install plugin from archive URL, vault folder, or marketplace list.
- Runtime tool discovery and calls with `mcp__<server>__<tool>` names.

## How to get to it (user POV)

- Settings → Agentic Chat → **MCP**.
- Turn on **Enable MCP**, then fill **Server name** and **HTTPS endpoint**, then
  click **Add MCP server**.
- Use **Test connection**, **Refresh tools**, or **Authenticate & test** on the
  server row.
- Settings → **Resources** → **Install plugin…** for a package with `mcp.json`.
- Mobile OAuth returns through `obsidian://agentic-chat-mcp-oauth`.

## Driving it with the probe harness

```ts
await openAgenticChatSettings();
await selectSettingsTab("MCP");
await setSettingToggle("Enable MCP", true);
await waitForMcpAddRow();
await setSettingTextByPlaceholder("Server name", "docs");
await setSettingTextByPlaceholder("https://mcp.example.com/mcp", "https://docs.example.com/mcp");
await clickMcpAddButton("Add MCP server");
```

- Server rows expose `.agentic-chat-mcp-server-header`,
  `.agentic-chat-oauth-banner`, and the **Authenticate & test** button.
- The OAuth browser flow is not scripted in a committed e2e. Unit tests drive
  discovery, registration, PKCE, callback delivery, and refresh.
- For a real remote call, use `test/e2e/specs/mcp-live.e2e.ts`; it needs
  `AGENTIC_CHAT_E2E_MCP_URL` and skips without it.
- Assert imported servers through `plugins.mcpState`; they start disabled.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| MCP tab: enable and add a server | `src/settings.ts:960` | `test/e2e/specs/settings-ui.e2e.ts:268` | `covered` |
| MCP-only proxy override | `src/settings.ts:983` | no committed check | `NONE` |
| Server enable toggle | `src/settings.ts:1237` | no committed check | `NONE` |
| Server approval policy | `src/settings.ts:1373` | `test/e2e/specs/settings-ui.e2e.ts:268` | `covered` |
| Static header auth | `src/settings.ts:1542` | `test/e2e/specs/settings-ui.e2e.ts:268` | `covered` |
| Bearer token auth | `src/settings.ts:1519` | no committed check | `NONE` |
| OAuth settings panel | `src/settings.ts:1576` | no committed check | `NONE` |
| OAuth required banner | `src/settings.ts:1266` | `test/e2e/specs/composio-install.e2e.ts:181` (banner and button only) | `partial` |
| Authenticate & test / PKCE sign-in | `src/settings.ts:1702` | `test/mcp-oauth.test.ts:155` (unit only) | `partial` |
| Desktop loopback callback | `src/mcp/oauth.ts:791` | `test/mcp-oauth.test.ts:155` (unit only) | `partial` |
| Mobile Obsidian protocol callback | `src/mcp/oauth.ts:848` | `test/mcp-oauth.test.ts:58` (unit only) | `partial` |
| OAuth token refresh | `src/mcp/oauth.ts:253` | `test/mcp-oauth.test.ts:513` (unit only) | `partial` |
| Test connection / refresh tools | `src/settings.ts:1259` | `test/mcp-tools.test.ts:229` (probe helper only) | `partial` |
| Tool allowlist/denylist | `src/settings.ts:1395` | `test/mcp-tools.test.ts:174` (unit only) | `partial` |
| Per-tool MCP approvals | `src/settings.ts:1448` | no committed check | `NONE` |
| Setup guide / Copy config | `src/settings.ts:1939` | `test/e2e/specs/settings-ui.e2e.ts:268` (button existence only) | `partial` |
| Composio bundle: 2 skills + 1 MCP | `src/plugins/import/install.ts:49` | `test/e2e/specs/composio-install.e2e.ts:27` | `covered` |
| Imported MCP servers start disabled | `src/plugins/loader.ts:322` | `test/e2e/specs/settings-ui.e2e.ts:311` | `covered` |
| Discover and call a remote MCP tool | `src/mcp/tools.ts:71` | `test/e2e/specs/mcp-live.e2e.ts:227` (gated on `AGENTIC_CHAT_E2E_MCP_URL`) | `partial` |
| Reject non-HTTPS MCP endpoints | `src/mcp/client.ts:647` | `test/mcp-client.test.ts:360` | `covered` |

## Gotchas

- Only HTTPS Streamable HTTP is supported. stdio and subprocess servers are out
  of scope.
- Adding a server writes a plugin package. The package owns the endpoint after
  creation; editing `settings.mcp.servers` directly is a legacy path.
- The **Install plugin…** modal is mapped in [Settings](./settings.md).
- Imported MCP servers start disabled. Enable them after install.
- Settings live in a popout. Query the settings window handle.
- OAuth needs Obsidian desktop for the localhost callback. Mobile uses the
  Obsidian protocol redirect.
- The callback state must match. A stale or foreign callback is rejected.
- OAuth tokens and MCP header values live in Obsidian secret storage.
- A 401 with `resource_metadata` shows the banner but does not auto-redirect.
- A live MCP spec skips without its URL. Read the counts; skip is not a pass.
