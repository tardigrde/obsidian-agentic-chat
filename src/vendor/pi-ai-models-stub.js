// Stub for @earendil-works/pi-ai/dist/models.generated.js
// The original is a 320KB static catalog of every provider's models.
// This plugin only supports openrouter/ollama/openai-compatible, so the
// full catalog is dead weight. An empty catalog means getModels() returns
// [] and the plugin falls back to default model metadata built in
// src/llm/models.ts.
// ponytail: empty catalog loses pre-cached pricing for known models.
//   Hardcode popular models here or fetch live if that matters.
export const MODELS = {};
