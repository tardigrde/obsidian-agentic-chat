# Web, MCP, and observability

These features are opt-in because they can send data outside your vault and model provider. Enable each one on its tab in **Settings > Agentic Chat** (**Web**, **MCP**, **Observability**). Until you enable a feature, its tools are not registered.

## Web access

When enabled, the agent receives:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search through Tavily, Brave, or SearXNG. |
| `fetch_url` | Fetch readable text from an HTTP or HTTPS URL. |

The built-in `/deep-research` skill is offered only while web access is enabled.

The fetch tool refuses non-HTTP schemes and localhost, private, and link-local hosts (SSRF guardrails). An optional **Fetch allowlist** restricts destinations to explicit host suffixes, for example `example.com, *.wikipedia.org, *`. An empty allowlist allows all public hosts. The plugin wraps vault, MCP, and web tool outputs as untrusted data, so the model treats them as data and not as instructions. See [Settings](../reference/settings.md#web) for the exact keys.

## When to enable what

| Feature | Enable it when | What leaves the device |
| --- | --- | --- |
| Web search and fetch | The task needs information outside the vault | Search queries go to Tavily, Brave, or SearXNG. Page URLs go to the target sites. Defaults: 5 results and 10,000 fetched characters. |
| MCP server | An external service has a tool the agent should call | Tool arguments go to your HTTPS servers, or to loopback HTTP servers on the same machine. There is no stdio. Enable each server after you check its endpoint. |
| Observability | You want to audit turns, cost, and errors externally | Metadata only by default. Text previews or full content only if you choose those payload modes. |

## MCP tools

MCP support uses HTTPS Streamable HTTP servers, or loopback HTTP for local servers. There is no stdio or subprocess transport.

Supported auth modes:

- none
- bearer token
- custom static header
- MCP OAuth

Remote tools are named `mcp__<server-id>__<tool-name>`. They use the approval gate and return capped text into model context. Large results become artifacts that the model can inspect with `read_artifact` and `search_artifact`.

## Observability

Observability can export traces to Langfuse or a generic OTLP HTTP endpoint.

Payload modes:

| Mode | Sends |
| --- | --- |
| Metadata only | Turn, model, tool, approval timing, token and cost totals, and errors. |
| Redacted text previews | Metadata plus short masked prompt and answer previews. |
| Full prompt/output content | Full prompt and answer text. Use it deliberately. |

No observability endpoint is bundled or enabled by default.
