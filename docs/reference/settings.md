# Settings Reference

**Settings > Agentic Chat**, organized into virtual tabs. Defaults shown are the plugin defaults.

## Models

Provider, key, model id, and request behavior.

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | `openrouter` | `openrouter`, `ollama`, or `openai-compatible`. |
| OpenRouter model | `moonshotai/kimi-k2.6` | Must be tool-capable. Browsing filters to zero-retention endpoints while strict routing is on. |
| Ollama server URL | `http://localhost:11434` | No key needed. |
| Ollama model | `llama3.1` | Tool-capable tag required. |
| OpenAI-compatible base URL | empty | Must serve `/chat/completions`; bare OpenWebUI roots resolve to `/api` (`http://localhost:3000/api`). |
| Context window override | `0` (auto-detect) | OpenRouter catalog first, then suffix match; unknown windows keep all tools and disable auto-compaction. |
| Temperature | `0.3` | Sampling randomness, 0–2. |
| Max response tokens | `0` | 0 lets the provider decide. |
| Request timeout | `90s` | How long to wait for the provider to start responding. |
| Network retries | `2` | Automatic retries on rate limits and transient errors. |
| HTTP proxy (desktop) | empty | `scheme://host:port`, no trailing slash. Mobile: leave empty, use device/VPN proxy. |

Keys live in Obsidian secret storage; `data.json` holds secret ids, not values.

## Agent

| Setting | Default | Notes |
| --- | --- | --- |
| Permission mode | Safe | Safe honors approval gates; YOLO auto-approves mutating tools for the session. Plan is entered via `/plan`, not here. |
| Thinking level | `off` | `off/minimal/low/medium/high/xhigh`; only reasoning-capable models are affected. |
| System prompt | built-in | Sent at the start of every conversation. |
| Standing instructions | vault root | `AGENTS.md` (fallback `CLAUDE.md` / `GEMINI.md`), injected every turn, truncated past 16,000 chars with notice. |
| Auto-compaction | on at 80% | Triggers at 50–95% context fill (configurable). |
| Tool budget | on | Withholds `web_*`, `list_artifacts`, etc. once schemas get large; unknown windows never drop. |

## Approval

| Setting | Notes |
| --- | --- |
| Before mutating tools | Global allow / ask / deny for vault-changing tools. |
| Working directories | Folders granted via `/add-dir`. Inside: policy applies; outside: asks first, including reads. |
| Per-tool overrides | Per-tool allow / ask / deny. Deny wins over everything, including YOLO. |
| Ignore patterns | Gitignore-style globs. Matched files are invisible (report as not found), not just denied. |

## Web

Off by default (tools not registered until enabled).

| Setting | Default |
| --- | --- |
| Search provider | Tavily (Brave needs key, SearXNG needs instance URL) |
| Max results | `5` (1–10) |
| Fetch character limit | `10,000` chars per page |
| Fetch allowlist | empty (all public hosts); comma-separated suffixes, deny wins on every redirect hop |

## MCP

Off by default. Servers live in agent plugin packages (`.agentic-plugins/`); **Add MCP server** writes a real package. Auth: none, bearer, custom header, or OAuth. Each server has its own enable toggle and allow / ask / deny policy. See [Agent Plugins](../features/agent-plugins.md).

## Observability

No endpoint bundled or enabled by default. Langfuse or generic OTLP HTTP. Payload: **Metadata only** (turn, model, tool, approval timing, tokens, cost, errors), **Redacted text previews**, or **Full prompt/output content**.

## Notifications

Master switch for background toasts (errors always show). **Cost alert** notifies once past a USD amount; **Cost cap** blocks new turns past a USD amount. Both default `0` (disabled).

## Resources

Read-only diagnostics: agent plugins, MCP tools, artifacts, retrieval state. Plugin management lives here too: **Install plugin…**, **New skill…**, **Remove**, **Repair built-ins**. See [Install](../guide/install.md#installing-agent-plugins).

- **Subagent timeout** — `0` (disabled). Auto-abort a child after N seconds, max 86400.

### Semantic retrieval

Off by default; reuses the Models-tab secrets. Lives under **Resources > Semantic retrieval**.

| Setting | Default |
| --- | --- |
| Embedding provider | OpenRouter, Ollama, or OpenAI-compatible |
| Vector dimensions | `1536` (must match the model) |
| Batch size | `32` notes per request |
| Max chars per note | `12,000` |
