# Web, MCP, and Observability

These features are opt-in because they can send data outside your vault and model provider.

## Web access

When enabled, the agent receives:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search through Tavily, Brave, or SearXNG. |
| `fetch_url` | Fetch readable text from an HTTP or HTTPS URL. |

The built-in `/deep-research` skill is offered only while web access is enabled.

The fetch tool has SSRF guardrails for non-HTTP schemes and localhost, private, and link-local hosts, plus an optional **Fetch allowlist** (`settings.web.allowedHosts`) that restricts destinations to explicit host suffixes (label-boundary-aware, `*.example.com` / `example.com` / `*`; deny wins over SSRF and on every redirect hop; empty = allow all public). Tool outputs (vault via `textResult`, MCP, `fetch_url`/`web_search`) are wrapped with `[BEGIN_UNTRUSTED_TOOL_OUTPUT ...]` / `[END_UNTRUSTED_TOOL_OUTPUT]` (inner markers escaped) so the model treats them as DATA, never as instructions — see `src/tools/tool-output-wrapper.ts` and the system prompt trust boundary.

## MCP tools

MCP support uses HTTPS Streamable HTTP servers only. There is no stdio or subprocess transport.

Supported auth modes:

- none
- bearer token
- custom static header
- MCP OAuth

Remote tools are named as `mcp__<server-id>__<tool-name>`, flow through the approval gate, and return capped text into model context. Large text results are stored as artifacts that the model can inspect with `read_artifact` and `search_artifact`.

## Observability

Observability can export traces to Langfuse or a generic OTLP HTTP endpoint.

Payload modes:

| Mode | Sends |
| --- | --- |
| Metadata only | Turn, model, tool, approval timing, token and cost totals, and errors. |
| Redacted text previews | Metadata plus short masked prompt and answer previews. |
| Full prompt/output content | Full prompt and answer text. Use deliberately. |

No observability endpoint is bundled or enabled by default.
