# Setup

Open **Settings > Agentic Chat** after you install the plugin, then pick a provider on the **Models** tab.

## OpenRouter

OpenRouter is the default provider. The default model is `moonshotai/kimi-k2.6`.

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Paste it into **Settings > Agentic Chat** on the **Models** tab.
3. Pick a model that supports tools. Model browsing shows only options that satisfy the zero-data-retention routing requirements while the strict defaults are on.
4. Keep the strict privacy routing defaults unless you want a broader provider set. Strict routing can mean a model has no compliant endpoint. In that case, pick another model, relax **Require zero data retention** or **Deny prompt logging** (prompts may then be logged or used for training), or use Ollama.

## First chat

1. Click the ribbon icon or run **Agentic Chat: Open chat**.
2. Open a note so it attaches automatically, then send a prompt such as `Summarize @Meeting-notes`.
3. The inline step card shows which notes the agent read before it answered.
4. Ask for a small edit, approve the diff, then run `/undo` to revert it.

If the model list is empty, see [Troubleshoot](./troubleshoot.md#no-model-answers).

## Ollama

Use Ollama when you want fully local model calls.

1. Run a local Ollama server.
2. Pull a model that supports tools.
3. Set the provider to **Ollama (local)**.
4. Keep the default server URL, `http://localhost:11434`, unless your Ollama server uses another address.
5. Enter the Ollama model tag.

Ollama requests stay on your device unless your own Ollama setup routes them elsewhere.

## OpenAI-compatible gateways

Choose **OpenAI-compatible** for gateways such as OpenWebUI, LM Studio, vLLM, llama.cpp, Chutes, or Venice.ai.

Set the base URL to the gateway root that serves `/chat/completions`. For OpenWebUI you can use the site root or the API base directly, because the plugin resolves a bare OpenWebUI root to `/api`. The default local OpenWebUI API base is:

```text
http://localhost:3000/api
```

Then paste the gateway bearer token and the model id that the gateway exposes.

## Thinking level

Some models support adjustable reasoning effort. The default is `off`. Set it in **Settings > Agentic Chat** on the **Agent** tab, or per message with `/effort [level]` in chat:

| Level | When to use it |
| --- | --- |
| `off` | Default. Simple questions and small edits. |
| `minimal`, `low` | A small amount of reasoning for routine tasks. |
| `medium` | Multi-step vault tasks. |
| `high`, `xhigh` | Hard planning and research. These levels use more tokens. |

Other models ignore the setting.

## Proxy settings

On desktop, **Models > Network proxy > HTTP proxy** lets plugin-owned model, model-browsing, web, MCP, and observability requests use an HTTP proxy. Enter `http://host:port` with no trailing slash. The plugin accepts only the http scheme.

On mobile, leave the plugin proxy fields empty and use the device, VPN, or network proxy.

## Semantic retrieval setup

If you want vector-based note search, enable **Settings > Agentic Chat > Advanced > Semantic retrieval**:

1. Choose an embedding provider (OpenRouter, Ollama, or OpenAI-compatible).
2. Enter the embedding model id.
3. Set vector dimensions to match the model (default 1536).
4. Use Ollama for fully local embeddings if you do not want note content sent to a remote provider.

After setup, run `/semantic-index estimate` to preview note and token counts, then `/semantic-index start` to build the index for your current scope.
