# Web, MCP, and observability

These features are opt-in because they send data outside your vault and model
provider. Enable each one in **Settings > Agentic Chat > Advanced** (**Web
access**, **MCP tools**, **Observability export**). Until you enable a feature,
its tools are not registered and it makes no requests.

## When to enable what

| Feature | Enable it when | What leaves the device |
| --- | --- | --- |
| Web search and fetch | The task needs information outside the vault | Search queries go to Tavily, Brave, or SearXNG. Page URLs go to the target sites. |
| MCP server | An external service has a tool the agent should call | Tool arguments go to your HTTPS servers, or to loopback HTTP servers on the same machine. |
| Observability | You want to audit turns, cost, and errors externally | Metadata only by default. Text previews or full content only if you choose those payload modes. |

## Web access

The setting shows an egress warning. When enabled, the agent receives:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search through Tavily, Brave, or SearXNG. Returns ranked title, URL, and snippet results (default 5, max 10). |
| `fetch_url` | Fetch readable text from an HTTP(S) URL. Scripts and markup are stripped. Long pages are paged with `offset` / `nextOffset` (default 10,000 characters per page). |
| `download_file` | Save a file (PDF, EPUB, Word, PowerPoint, Excel, CSV, text, JSON, or an image, up to 25 MB) from an HTTP(S) URL into the vault. It asks first in Safe mode, never overwrites, and never writes into a hidden folder. Then `import_document` reads a PDF or Office file. |
| `/deep-research` | Built-in skill: parallel Explorer subagents, an adversarial review, then a sourced note with a `## Sources` list. Offered only while web access is on. |

Guardrails:

- `fetch_url` refuses non-HTTP schemes and localhost, private, and link-local
  hosts (a best-effort SSRF guard).
- **Fetch allowlist** restricts destinations to host suffixes such as
  `example.com, *.wikipedia.org`, checked on every redirect hop. Empty allows
  all public hosts.
- Web, MCP, and vault tool outputs are wrapped as untrusted data
  (`[BEGIN_UNTRUSTED_TOOL_OUTPUT ...]`), so the model treats them as data, not
  instructions.

See [Settings](../reference/settings.md#web) for the keys.

## MCP tools

MCP covers **tool calls only**. Resources, prompts, roots, sampling, and rich
binary rendering are not supported.

### Add a server

1. Turn on **MCP tools** on the Advanced tab.
2. **Add MCP server**: name plus an HTTPS endpoint (or `http://localhost…` for a
   local server). This writes an [agent plugin](./agent-plugins.md) package
   (`plugin.json` + `mcp.json`) that owns the endpoint.
3. **Test connection** or **Authenticate & test**. The plugin detects OAuth by itself when the server asks for it; the manual choice is under the server's **Advanced** fold.
4. Set the server's approval policy (default **ask**) and enable it.

New installs have no servers or presets. Imported plugin packages bring their
servers in **disabled**; check each endpoint before you enable it.

### Transport and auth

- **Transport.** Streamable HTTP over HTTPS, or plain HTTP for loopback only.
  There is no stdio or subprocess transport, so the plugin never spawns
  processes and works on mobile.
- **Auth.** None, bearer token, static custom header, or MCP OAuth. Secrets and
  tokens are stored in Obsidian secret storage; `data.json` keeps only secret IDs.
- **OAuth.** Protected-resource and authorization-server discovery, PKCE,
  dynamic client registration when available, refresh tokens, and a
  re-auth/forget-token flow. Desktop uses a localhost callback; mobile uses
  `obsidian://agentic-chat-mcp-oauth` when the provider allows app redirects.
  Providers that require localhost redirects need desktop sign-in or a
  bearer/static header.

### How the agent sees MCP tools

- Names are `mcp__<server-id>__<tool-name>`.
- Tools are **deferred**: the system prompt lists one line per server, and the
  model loads the tools it needs with `search_tools`. Many servers do not bloat
  every request.
- Each call goes through the server's allow / ask / deny policy. Remote tool
  annotations are not treated as a safety boundary.
- Large text results become **artifacts**: the model gets a preview and an ID,
  then reads slices with the `artifact` tool without another remote call.
  Artifacts are pruned by age, count, and size, except those cited by saved
  sessions. Images and resources are summarized or omitted.

### Failures and diagnostics

Discovery, sign-in, refresh, and tool calls have bounded timeouts. The client
retries an OAuth refresh once, retries with server-advertised scopes on
`insufficient_scope`, falls back to older protocol versions, reopens an expired
session once, and makes bounded `Last-Event-ID` resume attempts. **Test
connection** lists tools through the runtime client; `/doctor` shows per-server
URL, auth state, and discovery errors.

## Observability

Export traces to **Langfuse** (base URL; posts OTLP/HTTP JSON to
`/api/public/otel/v1/traces`) or a **generic OTLP** `/v1/traces` endpoint. No
endpoint is bundled or enabled by default. Langfuse keys and OTLP auth headers
use Obsidian secret storage.

| Payload mode | Sends |
| --- | --- |
| **Metadata only** (default) | Turn, generation, tool, and approval spans; model and provider IDs; tokens; cost; stop reason; error class. No prompts, answers, note contents, tool args or results, or vault paths. |
| Redacted text previews | Metadata plus short masked prompt and answer previews. |
| Full prompt/output content | Full prompt and answer text. Use it deliberately. |

## Proxies

On desktop, **Models > Network proxy > HTTP proxy** (`http://host:port`, no
trailing slash) applies to model calls, model browsing, web tools, MCP, and
observability. MCP and observability have optional overrides; leave them empty
unless a server needs different routing. On mobile, leave all plugin proxy
fields empty and use the device, VPN, or network proxy.
