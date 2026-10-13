// Point d'entrée public de la couche LLM.
// Le reste de l'application importe uniquement depuis "./llm/index.js".
export type {
  ChatMessage,
  ContentPart,
  LlmClient,
  LlmClientOptions,
  LlmEffort,
  LlmEvent,
  StreamChatParams,
  ToolDefinition,
} from "./types.js";
export { createLlmClient } from "./factory.js";
