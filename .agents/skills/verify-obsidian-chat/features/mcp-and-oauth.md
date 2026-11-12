# MCP and OAuth

## Sub-features

- MCP master toggle and MCP-only proxy override.
- Add an HTTPS MCP server. The plugin writes an Agent Plugins package.
- Server row: enable, approval policy, test/refresh, OAuth sign-in.
- Auth modes: none, bearer token, static header, OAuth.
- OAuth discovery, dynamic client registration, PKCE, desktop loopback callback,
  mobile Obsidian protocol callback, token refresh.
- Tool allowlist/denylist and per-tool approvals.
- Plugin-provided MCP servers, imported disabled by default.
- Install plugin from archive URL, vault folder, or marketplace list.
- Runtime tool discovery and calls with `mcp__<server>__<tool>` names.

## How to get to it (user view)

- Open Settings and select Agentic Chat, then open **Advanced** and find **MCP tools**.
- Turn on **Enable MCP**, fill **Server name** and **HTTPS endpoint**, then click
  **Add MCP server**.
- Use **Test connection**, **Refresh tools**, or **Authenticate & test** on the
  server row.
- Open Settings, select **Advanced**, then click **Install plugin…** under **Agent plugins** for a
  package with `mcp.json`.
- Mobile OAuth returns through `obsidian://agentic-chat-mcp-oauth`.

## Driving it with the probe harness

```ts
await openAgenticChatSettings();
await selectSettingsTab("Advanced");
await setSettingToggle("Enable MCP", true);
await waitForMcpAddRow();
await setSettingTextByPlaceholder("Server name", "docs");
await setSettingTextByPlaceholder("https://mcp.example.com/mcp", "https://docs.example.com/mcp");
await clickMcpAddButton("Add MCP server");
```

- Server rows expose `.agentic-chat-mcp-server-header`,
  `.agentic-chat-oauth-banner`, and the **Authenticate & test** button.
- The OAuth browser flow is not scripted in a committed e2e. Unit tests cover
  discovery, registration, PKCE, callback delivery, and refresh.
- For a real remote call, use `test/e2e/specs/mcp-live.e2e.ts`. It needs
  `AGENTIC_CHAT_E2E_MCP_URL` and skips without it.
- Assert imported servers through `plugins.mcpState`. They start disabled.

## Proof

| entry point | source | proof | status |
|---|---|---|---|
| Advanced tab > MCP tools: enable and add a server | `src/settings.ts:1105` | `test/e2e/specs/settings-ui.e2e.ts:307` | `covered` |
| MCP-only proxy override | `src/settings.ts:1105` | no committed check | `NONE` |
| Server enable toggle | `src/settings.ts:1354` | no committed check | `NONE` |
| Server approval policy | `src/settings.ts:1354` | `test/e2e/specs/settings-ui.e2e.ts:307` | `covered` |
| Static header auth | `src/settings.ts:1667` | `test/e2e/specs/settings-ui.e2e.ts:307` | `covered` |
| Bearer token auth | `src/settings.ts:1667` | no committed check | `NONE` |
| OAuth settings panel | `src/settings.ts:1756` | no committed check | `NONE` |
| OAuth required banner | `src/settings.ts:1354` | `test/e2e/specs/composio-install.e2e.ts:241` (banner and button only) | `partial` |
| Authenticate & test / PKCE sign-in | `src/settings.ts:1861` | `test/mcp-oauth.test.ts:155` (unit only) | `partial` |
| Desktop loopback callback | `src/mcp/oauth.ts:792` | `test/mcp-oauth.test.ts:155` (unit only) | `partial` |
| Mobile Obsidian protocol callback | `src/mcp/oauth.ts:849` | `test/mcp-oauth.test.ts:58` (unit only) | `partial` |
| OAuth token refresh | `src/mcp/oauth.ts:273` | `test/mcp-oauth.test.ts:513` (unit only) | `partial` |
| Concurrent OAuth refresh shares one request | `src/mcp/oauth.ts:273` | `test/mcp-oauth.test.ts:610` | `partial` |
| Concurrent mobile OAuth callbacks route by state | `src/mcp/oauth.ts:932` | `test/mcp-oauth.test.ts:121` | `partial` |
| MCP handshake retries after a failed initialized notification | `src/mcp/client.ts:150` | `test/mcp-client.test.ts:112` | `partial` |
| Test connection / refresh tools | `src/settings.ts:1852` | `test/mcp-tools.test.ts:229` (probe helper only) | `partial` |
| Tool allowlist/denylist | `src/settings.ts:1554` | `test/mcp-tools.test.ts:174` (unit only) | `partial` |
| Per-tool MCP approvals | `src/settings.ts:1614` | no committed check | `NONE` |
| Setup guide / Copy config | `src/settings.ts:1354` | `test/e2e/specs/settings-ui.e2e.ts:307` (button existence only) | `partial` |
| Composio bundle: 2 skills + 1 MCP | `src/plugins/import/install.ts:49` | `test/e2e/specs/composio-install.e2e.ts:27` | `covered` |
| Imported MCP servers start disabled | `src/plugins/loader.ts:322` | `test/e2e/specs/settings-ui.e2e.ts:350` | `covered` |
| Discover and call a remote MCP tool | `src/mcp/tools.ts:72` | `test/e2e/specs/mcp-live.e2e.ts:227` (gated on `AGENTIC_CHAT_E2E_MCP_URL`) | `partial` |
| Reject non-HTTPS MCP endpoints except loopback | `src/mcp/client.ts:648` | `test/mcp-client.test.ts:360` (unit only) | `partial` |

## Gotchas

- The plugin supports HTTPS Streamable HTTP for routable hosts. It allows plain
  HTTP only for loopback. stdio and subprocess servers are out of scope.
- Adding a server writes a plugin package. The package defines the endpoint
  after creation. Editing `settings.mcp.servers` directly is a legacy path.
- See [Settings](./settings.md) for the **Install plugin…** modal.
- Imported MCP servers start disabled. Enable them after install.
- The settings window is a popout. Query its window handle.
- OAuth needs Obsidian desktop for the localhost callback. Mobile uses the
  Obsidian protocol redirect.
- The callback state must match. The plugin rejects a stale or foreign callback.
- Obsidian secret storage holds OAuth tokens and MCP header values.
- A 401 with `resource_metadata` shows the banner but does not auto-redirect.
- A live MCP spec skips without its URL. Read the counts; skip is not a pass.
