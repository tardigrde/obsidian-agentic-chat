# Settings reference

**Settings > Agentic Chat** has three tabs: **Models**, **Agent**, and **Advanced**. The defaults below are the plugin defaults.

## Models

Provider, API key, model id, and request behavior.

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | `openrouter` | `openrouter`, `ollama`, or `openai-compatible`. |
| OpenRouter model | `deepseek/deepseek-v4.1-flash` | Must support tools. The **Browse** list hides models without tool support and, with strict routing on, models without a zero-retention endpoint. |
| Ollama server URL | `http://localhost:11434` | No API key needed. |
| Ollama model | `llama3.1` | The tag must support tools. |
| OpenAI-compatible base URL | `http://localhost:3000/api` | Must serve `/chat/completions`. A bare gateway root resolves to `/api`. |
| Context window override | `0` (auto-detect) | Looks up the same model slug in the OpenRouter catalog, exact or unambiguous suffix. An unknown window keeps all tools and disables auto-compaction. |
| HTTP proxy (desktop) | empty | `http://host:port` with no trailing slash. Only the http scheme is accepted. On mobile, leave this empty and use the device or VPN proxy. |

Sampling is fixed: temperature `0.3`, no output-token cap (the provider decides),
a `90s` request timeout, and two retries on rate limits and transient errors.
These are not settings.

Keys live in Obsidian secret storage. `data.json` stores secret ids, not values.

## Agent

| Setting | Default | Notes |
| --- | --- | --- |
| Thinking level | `off` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Only models that support reasoning effort are affected. `off` sends no reasoning parameter, so the provider decides; the eval suite pins `low` for a reproducible measurement. |
| Auto-compaction | on | Triggers at 80% context fill. The threshold is fixed; the composer Safe/YOLO toggle is runtime-only and starts Safe at every launch. |

The system prompt is built in. Standing instructions come from `AGENTS.md` at
the vault root, with `CLAUDE.md` and `GEMINI.md` as fallbacks; the file is
loaded every turn and truncated after 16,000 characters with a notice. To
customize the prompt, edit that file.

### Approval

| Setting | Default | Notes |
| --- | --- | --- |
| Before mutating tools | ask | Global allow, ask, or deny for vault-changing tools. |
| Per-tool overrides | default | One row for every built-in tool: allow, ask, or deny (dispatch is allow/deny only; a recursive delete always asks unless deletes are explicitly allowed). The **Default** label shows what an unset tool really follows (read-only tools default allow; mutating tools follow the global policy). Deny wins over everything, including YOLO. |

## Advanced

### Web

Off by default. The plugin does not register the web tools until you enable them.

| Setting | Default |
| --- | --- |
| Search provider | Tavily. Brave needs an API key. SearXNG needs an instance URL. |
| Fetch allowlist | empty (all public hosts). Comma-separated suffixes. Deny wins on every redirect hop. |

Search returns at most five results and fetch returns at most 10,000 characters
per page by default; the tool call can ask for fewer or more within its own
bounds.

### MCP

Off by default. Servers live in agent plugin packages (`.agentic-plugins/`). **Add MCP server** writes a package with `plugin.json` and `mcp.json`. Auth modes: none, bearer, custom header, or OAuth. Each server has its own enable toggle and allow, ask, or deny policy. There is no separate settings-owned server list; an older user server is not migrated, and upgrade shows its name and URL so it can be added again. See [Agent plugins](../features/agent-plugins.md).

### Observability

No endpoint is bundled or enabled by default. Backends are Langfuse and generic OTLP HTTP. Payload modes are **Metadata only** (the default), **Redacted text previews**, and **Full prompt/output content**. Metadata includes the turn, model, tool, approval timing, tokens, cost, and errors.

### Notifications

The master switch controls background toasts. Errors always show. **Cost alert (USD)** sends one notice when the conversation cost passes a USD amount. **Hard spend cap (USD)** stops the running turn and blocks new turns at a USD amount. Both default to `0` (disabled).

### Agent plugins

Plugin management and diagnostics. Buttons: **Install plugin…** and **New skill…**. The installed plugin list shows enable toggles, spec status, component counts, and open-folder shortcuts. Packages you install or create start enabled. A package found in the plugins folder without an enable record starts disabled; the plugin shows one notice naming those packages, and you turn them on here. See [Install](../guide/install.md#installing-agent-plugins).

### Subagents

Ten subagents run at once in one turn; the rest queue. The limit is fixed, not
a setting.

There is no turn cap and no subagent timeout (removed in U4). Stop, the loop
guard, and the spend cap (`Spend cap`) end a run; the spend cap also counts
each subagent model call while it runs.

### Ignored files

- **Ignored paths**: private rules, separated by commas or new lines: a path glob or name, a `#tag`, or a `key=value` property (`key=` for any value). The agent is told a matching note is private and cannot read, list, search, or change it. See [Privacy](../guide/privacy.md#private-notes).
