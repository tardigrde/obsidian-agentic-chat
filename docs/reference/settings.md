# Settings Reference

The settings page is split into virtual tabs so setup and advanced features stay separate.

## Models

Configure provider, API key, model id, temperature, max tokens, timeouts, retries, and model-network proxy settings.

Providers:

- OpenRouter
- Ollama
- OpenAI-compatible

## Agent

Configure standing instructions, output style, compaction, memory, subagent profile folders, skills folders, and runtime resource behavior.

- **Permission mode** — Safe honors approval gates; YOLO auto-approves mutating tools for the session. Plan mode is entered via `/plan` in chat.
- **Temperature** — Sampling randomness (0–2).
- **Max response tokens** — Per model request. 0 lets the provider decide.
- **Request timeout** — How long to wait for the provider to start responding.
- **Network retries** — Automatic retries on rate limits and transient errors.
- **System prompt** — Sent at the start of every conversation.
- **Standing instructions** — `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) loaded from the vault root every turn.
- **Context window** — Auto-compaction settings: summarize older turns automatically as the context window fills.
- **Tool budget** — Drop optional tools when registered tool schemas exceed a threshold percent of the context window.
- **Subagents** — Built-in roster toggle, vault folder for `AGENT.md` profiles, and the subagent timeout (auto-abort a child after N seconds; 0 disables, max 86400).

### Context-window resolution

OpenRouter models use the live `/models` catalog for their context window. For the
OpenAI-compatible provider, the plugin tries the OpenRouter catalog for the same
model slug (exact, or an unambiguous suffix match); otherwise the window is treated
as **unknown**. Unknown windows keep every tool (the tool budget never drops) and
disable auto-compaction rather than guessing 128k and silently dropping optional
tools. If your gateway exposes a window different from OpenRouter's, set the
provider's **Context window (tokens)** setting (0 = auto-detect).

## Approval

Set the default mode, mutating-tool policy, per-tool overrides, working directories, and ignore patterns.

- **Before mutating tools** — Global allow/ask/deny for tools that change the vault.
- **Working directories** — Grant folders as a working set. Inside granted folders reads and writes auto-run; outside asks first.
- **Per-tool overrides** — Allow, ask, or deny for individual tools.

## Web

Enable web access and configure Tavily, Brave, or SearXNG credentials and endpoints, plus an optional destination allowlist.

- **Search provider** — Tavily, Brave, or SearXNG.
- **Max results** — Default search results to return (1–10).
- **Fetch character limit** — Cap on characters of fetched page text returned to the model.
- **Fetch allowlist** (`settings.web.allowedHosts`, comma-separated host suffixes, e.g. `example.com, *.wikipedia.org, *`) — limits `fetch_url` destinations with label-boundary-aware matching; empty allows all public hosts. Deny wins over SSRF and on every redirect hop. Web/MCP/vault tool outputs are wrapped as untrusted data (`[BEGIN_UNTRUSTED_TOOL_OUTPUT ...]` / `[END_UNTRUSTED_TOOL_OUTPUT]`, inner markers escaped) so the model does not follow injected instructions inside tool results.

## MCP

Enable remote MCP, generate agent plugin packages for HTTPS Streamable HTTP servers, choose auth, test discovery, and set per-server approval policy.

MCP servers now live inside **agent plugins** (`.agentic-plugins/` by default) — the plugins folder is the single source of truth. The MCP tab's **Add MCP server** form writes a real plugin package (`plugin.json` + `mcp.json`); endpoint and headers come from the package, while authentication, approval, and enable state stay client-owned.

Supported auth modes:

- none
- bearer token
- custom static header
- MCP OAuth

## Observability

Enable trace export, choose Langfuse or generic OTLP, set endpoint and auth, choose payload mode, and configure observability-specific proxy settings.

Payload modes:

| Mode | Sends |
| --- | --- |
| Metadata only | Turn, model, tool, approval timing, token and cost totals, and errors. |
| Redacted text previews | Metadata plus short masked prompt and answer previews. |
| Full prompt/output content | Full prompt and answer text. Use deliberately. |

## Notifications

Configure cost alerts, spend caps, and related usage notifications.

- **Cost alert** — Notify once when session cost crosses a USD amount.
- **Cost cap** — Hard cap: block new turns once session cost reaches this USD amount.

## Resources

Inspect runtime resources such as agent plugins, MCP tools, artifacts, retrieval state, and diagnostics surfaced by the plugin.

Also includes:

- **Agent plugins** — Vault folder scanned for agent plugin packages (`plugin.json` + `skills/` + `mcp.json`), with per-plugin enable toggles and open-folder shortcuts. See [Agent Plugins](../features/agent-plugins.md).
- **Subagents** — Enable built-in subagents and configure a vault folder for `AGENT.md` profiles.

## Semantic retrieval

Opt-in semantic index configuration. Uses the same provider secrets as the Models tab.

- **Embedding provider** — OpenRouter, Ollama, or OpenAI-compatible.
- **Embedding model** — Model id for the chosen provider.
- **Vector dimensions** — Expected embedding vector size.
- **Language coverage** — Multilingual, monolingual, or unknown.
- **Batch size** — Maximum notes per embedding request.
- **Max indexed characters per note** — Upper bound sent to the embedding provider.
