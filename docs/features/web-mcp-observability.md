# Web, MCP, and Observability

These features are opt-in because they can send data outside your vault and model provider. Enable each on its tab in **Settings > Agentic Chat** (**Web**, **MCP**, **Observability**); until then the tools are not registered and the agent cannot reach the network.

## Web access

When enabled, the agent receives:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search through Tavily, Brave, or SearXNG. |
| `fetch_url` | Fetch readable text from an HTTP or HTTPS URL. |

The built-in `/deep-research` skill is offered only while web access is enabled.

The fetch tool refuses non-HTTP schemes and localhost/private/link-local hosts (SSRF guardrails), plus an optional **Fetch allowlist** that restricts destinations to explicit host suffixes (e.g. `example.com, *.wikipedia.org, *`; empty allows all public hosts). Vault, MCP, and web tool outputs are wrapped as untrusted data so the model treats them as data, never instructions. See [Settings](../reference/settings.md#web) for the exact keys.

## When to enable what

| Feature | Enable it when | What leaves the device |
| --- | --- | --- |
| Web search + fetch | The task needs information outside the vault | Queries to Tavily/Brave/SearXNG; page URLs to target sites (max 5 results, 10,000 fetched chars by default) |
| MCP server | An external service has a tool the agent should call | Tool arguments to your HTTPS servers only (no stdio); enable each server after checking its endpoint |
| Observability | You want to audit turns, cost, and errors externally | Metadata only by default; text previews or full content only if you choose those payload modes |

## MCP tools

MCP support uses HTTPS Streamable HTTP servers only. There is no stdio or subprocess transport.

Supported auth modes:

- none
- bearer token
- custom static header
- MCP OAuth

Remote tools are named `mcp__<server-id>__<tool-name>`, flow through the approval gate, and return capped text into model context. Large results are stored as artifacts the model can inspect with `read_artifact` and `search_artifact`.

## Observability

Observability can export traces to Langfuse or a generic OTLP HTTP endpoint.

Payload modes:

| Mode | Sends |
| --- | --- |
| Metadata only | Turn, model, tool, approval timing, token and cost totals, and errors. |
| Redacted text previews | Metadata plus short masked prompt and answer previews. |
| Full prompt/output content | Full prompt and answer text. Use deliberately. |

No observability endpoint is bundled or enabled by default.
