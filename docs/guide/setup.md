# Setup

Open **Settings > Agentic Chat** after installing the plugin, then pick a provider on the **Models** virtual tab.

## OpenRouter

OpenRouter is the default provider (default model `moonshotai/kimi-k2.6`).

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Paste it into **Settings > Agentic Chat** on the **Models** tab.
3. Pick a tool-capable model. Model browsing only shows options that satisfy the zero-data-retention routing requirements while the strict defaults are on.
4. Keep the strict privacy routing defaults enabled unless you deliberately want a broader provider set. Strict routing can mean a model has no compliant endpoint — then pick another model, deliberately relax **Require zero data retention** / **Deny prompt logging** (prompts may then be retained or trained on), or use Ollama.

## First chat

1. Click the ribbon icon or run **Agentic Chat: Open chat**.
2. Open any note so it auto-attaches, then send something like `Summarize @Meeting-notes`.
3. Watch the inline step card: it shows which notes were read before the answer.
4. Ask for a small edit, approve the diff, then run `/undo` to see the safety net work.

If the model list is empty, see [Troubleshoot](./troubleshoot.md#no-model-answers).

## Ollama

Use Ollama when you want fully local model calls.

1. Run a local Ollama server.
2. Pull a tool-capable model.
3. Set the provider to **Ollama (local)**.
4. Keep the default server URL, `http://localhost:11434`, unless your Ollama server is elsewhere.
5. Enter the Ollama model tag.

Ollama requests stay on your device unless your own Ollama setup routes them elsewhere.

## OpenAI-compatible gateways

Choose **OpenAI-compatible** for gateways such as OpenWebUI, LM Studio, vLLM, llama.cpp, Chutes, or Venice.ai.

Set the base URL to the gateway root whose `/chat/completions` endpoint is valid. For OpenWebUI you can use the site root or the API base directly; the plugin resolves bare OpenWebUI roots to `/api`. The default local OpenWebUI API base is:

```text
http://localhost:3000/api
```

Then paste the gateway bearer token and model id exposed by that gateway.

## Thinking level

Some models support adjustable reasoning effort. Default `off`. Set it in **Settings > Agentic Chat** on the **Agent** tab, or per message with `/effort [level]` in chat:

| Level | When to use it |
| --- | --- |
| `off` | Default. Simple Q&A and small edits. |
| `minimal`, `low` | Slightly harder reasoning without much extra cost. |
| `medium` | Balanced depth for multi-step vault tasks. |
| `high`, `xhigh` | Hard planning and research; costs more tokens. |

Only models that support reasoning effort are affected; others ignore the setting.

## Proxy settings

On desktop, **Models > Network proxy > HTTP proxy** lets plugin-owned model, model-browsing, web, MCP, and observability requests use an HTTP proxy. Enter it as `http://host:port` (http only, no trailing slash).

On mobile, leave plugin proxy fields empty and use the device, VPN, or network-level proxy path.

## Semantic retrieval setup

If you want vector-based note search, enable **Settings > Resources > Semantic retrieval**:

1. Choose an embedding provider (OpenRouter, Ollama, or OpenAI-compatible).
2. Enter the embedding model id.
3. Set vector dimensions to match the model (default 1536).
4. Use Ollama for fully local embeddings if you do not want note content sent to a remote provider.

After setup, run `/semantic-index estimate` to preview note/token counts, then `/semantic-index start` to build the index for your current scope.
