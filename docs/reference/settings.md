# Settings reference

**Settings > Agentic Chat** uses virtual tabs. The defaults below are the plugin defaults.

## Models

Provider, API key, model id, and request behavior.

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | `openrouter` | `openrouter`, `ollama`, or `openai-compatible`. |
| OpenRouter model | `moonshotai/kimi-k2.6` | Must support tools. The **Browse** list hides models without tool support and, with strict routing on, models without a zero-retention endpoint. |
| Ollama server URL | `http://localhost:11434` | No API key needed. |
| Ollama model | `llama3.1` | The tag must support tools. |
| OpenAI-compatible base URL | `http://localhost:3000/api` | Must serve `/chat/completions`. A bare gateway root resolves to `/api`. |
| Context window override | `0` (auto-detect) | Looks up the same model slug in the OpenRouter catalog, exact or unambiguous suffix. An unknown window keeps all tools and disables auto-compaction. |
| Temperature | `0.3` | Sampling randomness from 0 to 2. |
| Max response tokens | `0` | `0` lets the provider decide. |
| Request timeout | `90s` | How long to wait for the provider to start responding. |
| Network retries | `2` | Retries on rate limits and transient errors. |
| HTTP proxy (desktop) | empty | `http://host:port` with no trailing slash. Only the http scheme is accepted. On mobile, leave this empty and use the device or VPN proxy. |

Keys live in Obsidian secret storage. `data.json` stores secret ids, not values.

## Agent

| Setting | Default | Notes |
| --- | --- | --- |
| Permission mode | Safe | Safe follows the approval gates. YOLO auto-approves most mutating tools until you switch back; recursive folder deletes and `create_skill` still ask. Plan is read-only and is also available in this dropdown, through `/plan`, or through `/config`. |
| Thinking level | `off` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Only models that support reasoning effort are affected. |
| System prompt | built-in | Sent at the start of every conversation. |
| Standing instructions | vault root | `AGENTS.md`, with `CLAUDE.md` and `GEMINI.md` as fallbacks. Loaded every turn and truncated after 16,000 characters with a notice. |
| Auto-compaction | on at 80% | Triggers at 50% to 95% context fill (configurable). |
| Tool budget | on | Withholds optional tools (web, MCP, subagent, document import, artifacts) when tool schemas exceed 2% of the context window. An unknown window never drops tools. |

## Approval

| Setting | Default | Notes |
| --- | --- | --- |
| Before mutating tools | ask | Global allow, ask, or deny for vault-changing tools. |
| Working directories | empty | Folders granted with `/add-dir`. In Safe mode, the approval policy applies inside a granted folder. Outside, the agent asks first, including reads. |
| Per-tool overrides | default | Per-tool allow, ask, or deny. Deny wins over everything, including YOLO. |

## Web

Off by default. The plugin does not register the web tools until you enable them.

| Setting | Default |
| --- | --- |
| Search provider | Tavily. Brave needs an API key. SearXNG needs an instance URL. |
| Max results | `5` (1 to 10) |
| Fetch character limit | `10,000` characters per page |
| Fetch allowlist | empty (all public hosts). Comma-separated suffixes. Deny wins on every redirect hop. |

## MCP

Off by default. Servers live in agent plugin packages (`.agentic-plugins/`). **Add MCP server** writes a package with `plugin.json` and `mcp.json`. Auth modes: none, bearer, custom header, or OAuth. Each server has its own enable toggle and allow, ask, or deny policy. See [Agent plugins](../features/agent-plugins.md).

## Observability

No endpoint is bundled or enabled by default. Backends are Langfuse and generic OTLP HTTP. Payload modes are **Metadata only** (the default), **Redacted text previews**, and **Full prompt/output content**. Metadata includes the turn, model, tool, approval timing, tokens, cost, and errors.

## Notifications

The master switch controls background toasts. Errors always show. **Cost alert** sends one notice when the conversation cost passes a USD amount. **Cost cap** stops the running turn and blocks new turns at a USD amount. Both default to `0` (disabled).

## Resources

Plugin management and diagnostics. Buttons: **Install plugin…**, **New skill…**, and **Repair built-ins**. The installed plugin list shows enable toggles, spec status, component counts, and open-folder shortcuts. See [Install](../guide/install.md#installing-agent-plugins).

- **Subagent timeout**: `0` (disabled). Auto-abort a child after N seconds, up to 86400.
- **Ignore list**: one gitignore-style glob per line. Matching notes are invisible to the agent and report as not found.

### Semantic retrieval

Off by default. Reuses the secrets on the **Models** tab. Lives under **Resources > Semantic retrieval**.

| Setting | Default |
| --- | --- |
| Embedding provider | OpenRouter |
| Embedding model | `openai/text-embedding-3-small` on OpenRouter, `nomic-embed-text` on Ollama, empty on OpenAI-compatible until you set one |
| Vector dimensions | `1536` (must match the model) |
| Language coverage | `multilingual` |
| Batch size | `32` notes per request |
| Max indexed characters per note | `12,000` |
