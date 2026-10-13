// Point d'entrée public de la couche embeddings.
// Le reste du RAG importe uniquement depuis "./embeddings/index.js".
export type { EmbedDocumentsResult, EmbeddingClient, EmbeddingClientOptions, EmbedOptions } from "./types.js";
export { createEmbeddingClient } from "./factory.js";
