// Stub for @earendil-works/pi-ai/dist/models.generated.js
// The original is a static catalog of every provider's models, split by type.
// This plugin fetches live pricing from OpenRouter and stores it in
// a local cache file, so the full catalog is dead weight.
// getModels() returns [] and the plugin resolves pricing via
// src/llm/pricing-cache.ts.
//
// pi-ai 0.99 added the image and classifier catalogs alongside the chat one;
// mirror all three so a future import of either still resolves.
export const MODELS = {};
export const IMAGE_MODELS = {};
export const CLASSIFIER_MODELS = {};
