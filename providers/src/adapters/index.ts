// Provider implementations, reached only by the composition root and tests (T07 boundary).
export { LOCAL_MODEL_NOT_IMPLEMENTED, LocalModelProvider } from "./local-model.ts";
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible.ts";
