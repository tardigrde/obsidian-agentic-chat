# Setup

Open the Agentic Chat settings tab after installing the plugin. The main setup choice is the model provider.

## OpenRouter

OpenRouter is the default hosted provider path.

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Paste it into **Settings > Agentic Chat > Models**.
3. Pick a tool-capable model. The default model is `moonshotai/kimi-k2.6`.
4. Keep the strict privacy routing defaults enabled unless you deliberately want a broader provider set.

With the default privacy settings, model browsing only shows options that can satisfy the zero-data-retention routing requirements.

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

Some models support adjustable reasoning effort. Set it in **Settings > Agent > Thinking level**:

| Level | Behavior |
| --- | --- |
| `off` | No extra reasoning tokens. |
| `minimal` | Light internal reasoning. |
| `low` | Moderate reasoning. |
| `medium` | Balanced depth. |
| `high` | Deep reasoning, more tokens. |
| `xhigh` | Maximum reasoning depth. |

You can also set effort per message with `/effort [level]` in chat.

## Proxy settings

On desktop, **Models > Network proxy > HTTP proxy** lets plugin-owned model, model-browsing, web, MCP, and observability requests use an HTTP proxy such as:

```text
http://host:port
```

On mobile, leave plugin proxy fields empty and use the device, VPN, or network-level proxy path.

## Semantic retrieval setup

If you want vector-based note search, enable **Settings > Resources > Semantic retrieval**:

1. Choose an embedding provider (OpenRouter, Ollama, or OpenAI-compatible).
2. Enter the embedding model id.
3. Set vector dimensions to match the model (default 1536).
4. Use Ollama for fully local embeddings if you do not want note content sent to a remote provider.

After setup, run `/semantic-index start` in chat to build the index for your current scope.
