// Adapter implementations of this package. Only the composition root imports
// this entry (module-boundary, V01-T07); upper code uses the ports in "@pki/providers".
export { LOCAL_MODEL_NOT_IMPLEMENTED, LocalModelProvider } from "./local-model.ts";
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible.ts";
export { createLocalEmbedder } from "./transformers-embedder.ts";
