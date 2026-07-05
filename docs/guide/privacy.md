# Privacy Model

Agentic Chat is designed around explicit egress and visible action.

## Defaults

- No telemetry is sent by default.
- Web access is off by default.
- MCP is off by default.
- Observability export is off by default.
- Provider API keys, MCP secrets, web-search keys, and OAuth tokens use Obsidian secret storage.
- The vault `data.json` stores secret ids and non-secret settings, not secret values.

## OpenRouter routing

OpenRouter requests use privacy routing options by default:

| Setting | Effect | Default |
| --- | --- | --- |
| Require zero data retention | `zdr: true`, only endpoints that retain nothing | on |
| Deny prompt logging and training | `data_collection: "deny"` | on |
| Allow provider fallbacks | Fallbacks are allowed only if they obey the same privacy rules | on |

Strict routing can mean a model has no compliant endpoint. In that case, choose another model, relax the routing settings deliberately, or use Ollama.

## Local mode

Ollama keeps prompts, note content, and tool results on your device, assuming your Ollama server itself is local.

## Tool visibility

Every read, search, write, edit, rename, delete, frontmatter change, web request, and MCP call is surfaced as a visible step in the conversation.

Mutating vault tools are approval-gated and deletes go to trash.

## Opt-in egress

Web access sends search queries to the selected search backend and fetched URLs to the target sites.

MCP sends tool arguments to the HTTPS MCP servers you configure.

Observability sends trace data to the OTLP or Langfuse endpoint you configure. Metadata-only is the default payload mode.
