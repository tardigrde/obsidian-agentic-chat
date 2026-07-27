import { createModels, createProvider, type Models, type ProviderAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { obsidianOpenAICompletionsApi } from "./openai-compatible-request";

/**
 * Auth for self-configured providers: the plugin always passes the key (when
 * one exists) through per-request stream options, so resolution just reports
 * the provider as configured. Local/keyless gateways resolve with no key.
 */
function passthroughAuth(name: string): ProviderAuth {
  return {
    apiKey: {
      name,
      resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
    },
  };
}

/**
 * The pi-ai `Models` runtime the agent streams through. Routes each request to
 * the provider that owns the model:
 * - `openrouter`: built-in provider, real SSE streaming via fetch.
 * - `ollama`: OpenAI-compatible endpoint, real SSE streaming via fetch.
 * - `openai-compatible`: self-hosted gateways, non-streaming via Obsidian's
 *   `requestUrl` to sidestep renderer CORS/proxy issues.
 *
 * Base URLs and API keys arrive per request (baked into the `Model` built by
 * `buildModel()` and passed via stream options), so the collection is static
 * and never needs rebuilding when settings change.
 */
export function createAgentModels(): Models {
  const models = createModels();
  models.setProvider(openrouterProvider());
  models.setProvider(
    createProvider({
      id: "ollama",
      name: "Ollama",
      auth: passthroughAuth("Ollama"),
      models: [],
      api: openAICompletionsApi(),
    }),
  );
  models.setProvider(
    createProvider({
      id: "openai-compatible",
      name: "OpenAI-compatible",
      auth: passthroughAuth("OpenAI-compatible gateway"),
      models: [],
      api: obsidianOpenAICompletionsApi(),
    }),
  );
  return models;
}

let shared: Models | undefined;

/** Lazily-created shared `Models` collection used by the stream runtimes. */
export function sharedAgentModels(): Models {
  shared ??= createAgentModels();
  return shared;
}
