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
| Advanced tab > MCP tools: enable and add a server | `src/settings-mcp-section.ts#definitions` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` | `covered` |
| MCP-only proxy override | `src/settings-mcp-section.ts#definitions` | no committed check | `NONE` |
| Server enable toggle | `src/settings-mcp-section.ts#mcpServerDefinitions` | no committed check | `NONE` |
| Server approval policy | `src/settings-mcp-section.ts#mcpServerDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` | `covered` |
| Static header auth | `src/settings-mcp-section.ts#mcpAuthenticationDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` | `covered` |
| Bearer token auth | `src/settings-mcp-section.ts#mcpAuthenticationDefinitions` | no committed check | `NONE` |
| OAuth settings panel | `src/settings-mcp-section.ts#mcpOAuthDefinitions` | no committed check | `NONE` |
| OAuth required banner | `src/settings-mcp-section.ts#definitions` | `test/e2e/specs/composio-install.e2e.ts#shows OAuth banner for bare MCP when 401 advertises resource_metadata (no auto-redirect)` (banner and button only) | `partial` |
| Authenticate & test / PKCE sign-in | `src/settings-mcp-section.ts#authenticateAndProbeMcpServer` | `test/mcp-oauth.test.ts#falls back to an ephemeral callback port when the stable port is busy for dynamic clients` (unit only) | `partial` |
| Desktop loopback callback | `src/mcp/oauth/callback-receivers.ts#createLoopbackOAuthCallbackReceiver` | `test/mcp-oauth.test.ts#falls back to an ephemeral callback port when the stable port is busy for dynamic clients` (unit only) | `partial` |
| Mobile Obsidian protocol callback | `src/mcp/oauth/callback-receivers.ts#ObsidianProtocolOAuthCallbackReceiver` | `test/mcp-oauth.test.ts#delivers Obsidian protocol OAuth callbacks for mobile sign-in` (unit only) | `partial` |
| OAuth token refresh | `src/mcp/oauth.ts#refreshMcpOAuthToken` | `test/mcp-oauth.test.ts#falls back to well-known protected-resource metadata when the auth challenge request times out` (unit only) | `partial` |
| Concurrent OAuth refresh shares one request | `src/mcp/oauth.ts#refreshMcpOAuthToken` | `test/mcp-oauth.test.ts#runs one refresh for concurrent callers and keeps the rotated tokens` | `partial` |
| Concurrent mobile OAuth callbacks route by state | `src/mcp/oauth/callback-receivers.ts#handleProtocolCallback` | `test/mcp-oauth.test.ts#does not let a fresh receiver consume another flow's callback` | `partial` |
| MCP handshake retries after a failed initialized notification | `src/mcp/client.ts#initialize` | `test/mcp-client.test.ts#does not mark the client initialized when the initialized notification fails` | `partial` |
| Test connection / refresh tools | `src/settings-mcp-section.ts#testMcpServer` | `test/mcp-tools.test.ts#probes a server with the same initialize and list-tools path used for registration` (probe helper only) | `partial` |
| Tool allowlist/denylist | `src/settings-mcp-section.ts#mcpToolFilterDefinitions` | `test/mcp-tools.test.ts#filters discovered tools by enabled/disabled globs before registration` (unit only) | `partial` |
| Per-tool MCP approvals | `src/settings-mcp-section.ts#mcpToolApprovalDefinitions` | no committed check | `NONE` |
| Setup guide / Copy config | `src/settings-mcp-section.ts#mcpServerDefinitions` | `test/e2e/specs/settings-ui.e2e.ts#persists web access settings through the Advanced tab` (button existence only) | `partial` |
| Composio bundle: 2 skills + 1 MCP | `src/plugins/import/install.ts#installPackage` | `test/e2e/specs/composio-install.e2e.ts#installs Composio bundle via archive URL and verifies 2 skills + 1 MCP (popout-safe)` | `covered` |
| Imported MCP servers start disabled | `src/plugins/loader.ts#mcpServerFromPluginEntry` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| Discover and call a remote MCP tool | `src/mcp/tools.ts#createMcpTools` | `test/e2e/specs/mcp-live.e2e.ts#agentic-chat live MCP over HTTPS` (gated on `AGENTIC_CHAT_E2E_MCP_URL`) | `partial` |
| Reject non-HTTPS MCP endpoints except loopback | `src/mcp/client.ts#normalizeMcpUrl` | `test/mcp-client.test.ts#makes multiple Last-Event-ID resume attempts when SSE redelivery is incremental` (unit only) | `partial` |
| MCP server: Name | `src/settings-mcp-section.ts#row("Name"` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `partial` |
| MCP server: Server id | `src/settings-mcp-section.ts#row("Server id"` | no committed check | `NONE` |
| MCP server: HTTPS endpoint | `src/settings-mcp-section.ts#row("HTTPS endpoint"` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| MCP server: Tool approvals | `src/settings-mcp-section.ts#row("Tool approvals"` | `test/e2e/specs/mobile-viewport.e2e.ts#keeps the settings tab UI usable at phone width` (heading render only) | `partial` |
| MCP server: Authentication | `src/settings-mcp-section.ts#row("Authentication"` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| MCP server: Auth header | `src/settings-mcp-section.ts#row("Auth header"` | `test/e2e/specs/settings-ui.e2e.ts#generates a plugin package and persists its MCP server through the Advanced tab` | `covered` |
| MCP server: OAuth status | `src/settings-mcp-section.ts#row("OAuth status"` | no committed check | `NONE` |
| MCP server: OAuth client id | `src/settings-mcp-section.ts#row("OAuth client id"` | no committed check | `NONE` |

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
