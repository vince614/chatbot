// Point d'entrée public de la couche LLM.
// Le reste de l'application importe uniquement depuis "./llm/index.js".
export type { ChatMessage, LlmClient, LlmClientOptions, StreamChatParams } from "./types.js";
export { createLlmClient } from "./factory.js";
