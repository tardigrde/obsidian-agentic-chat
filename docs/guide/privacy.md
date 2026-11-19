# Privacy model

Agentic Chat sends vault content only to services you configure. Chat requests go to your model provider, and opt-in features such as web, MCP, and observability add their own egress paths. The plugin renders every tool call inline.

## Defaults

- No telemetry and no analytics. The only request the plugin makes on its own
  fetches OpenRouter's public model catalog to update local pricing, when the
  cache is missing or older than three days. It contains no vault content.
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

## Ignore list

Globs in **Settings > Advanced > Ignored files** (for example `Private/`,
`*.secret.md`, `**/diary/**`) hide notes from the agent. Matching files report
as not found to every tool and are never auto-attached. Two exceptions still
reach the model: the standing-instructions file (`AGENTS.md`, `CLAUDE.md`, or
`GEMINI.md`) is sent every turn even if it matches a glob, and an image you
attach yourself is sent as you chose. Do not keep secrets in the instructions
file.

## Tool visibility

The conversation shows every read, search, write, edit, rename, delete, frontmatter change, web request, and MCP call as a step.

Mutating vault tools are approval-gated. Deletes go to trash when possible (see
below).

## Opt-in egress

Web access sends search queries to the selected search backend and fetched URLs to the target sites.

MCP sends tool arguments to the MCP servers you configure. Servers outside the local machine must use HTTPS.

Observability sends trace data to the OTLP or Langfuse endpoint you configure. Metadata-only is the default payload mode.


## Document import privacy

The `import_document` tool extracts text from vault files into plugin-managed source artifacts. The plugin stores the extracted text locally in the artifact system and sends it to the model only when the agent reads the artifact.

## Disclosures

In line with the [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies):

- **Network use.** With OpenRouter, prompts, attached or read note content, and
  tool results go to OpenRouter and the provider it routes to, subject to the
  routing settings above. With Ollama or an OpenAI-compatible gateway, requests
  go to the server you configure. Web access, MCP, and observability are opt-in
  and send data only when enabled. The pricing-cache request contains no vault
  content.
- **Account and payment.** OpenRouter needs your account and API key and bills
  hosted models to that account. The plugin is free and takes no payment.
  Ollama needs no account.
- **File access.** The agent reads and changes vault files through Obsidian's
  vault API, only in response to your prompts. Mutating tools pass the approval
  gate. Deletes go to trash when Obsidian or the OS can trash them; if both trash
  paths fail, the plugin removes the file permanently. Ignored files are never
  exposed.
- **Telemetry.** None. Observability sends data only after you enable it and set
  an endpoint.
- **Source.** Open source under the MIT license.
