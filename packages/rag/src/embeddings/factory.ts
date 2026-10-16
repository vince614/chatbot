import type { EmbeddingClient, EmbeddingClientOptions } from "./types.js";
import { VoyageEmbeddingClient } from "./voyage.js";

const KNOWN_PROVIDERS = ["voyage"] as const;

/** Instancie le client correspondant à EMBEDDING_PROVIDER. */
export function createEmbeddingClient({ provider, apiKey, model, dimension }: EmbeddingClientOptions): EmbeddingClient {
  switch (provider) {
    case "voyage":
      return new VoyageEmbeddingClient({ apiKey, model, dimension });
    default:
      throw new Error(
        `Fournisseur d'embeddings inconnu : "${provider}". Valeurs possibles : ${KNOWN_PROVIDERS.join(", ")}.`,
      );
  }
}
