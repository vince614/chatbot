import { fileURLToPath } from "node:url";

import { ConfigError, loadDotEnv, requireEnv } from "../config.js";
import type { EmbeddingClientOptions } from "./embeddings/index.js";
import { SEARCH_MODES, type SearchMode } from "./retrieve.js";

/**
 * Configuration du RAG, séparée de celle du serveur : le serveur de chat n'a
 * pas besoin de la base pour l'instant, et les scripts d'ingestion n'ont pas
 * besoin de la clé LLM. Chaque script ne demande que ce qu'il utilise.
 */

/** Dossier où tu déposes les PDF à ingérer (apps/api/data/pdfs/), indépendant du répertoire courant. */
export const PDF_DIR = fileURLToPath(new URL("../../data/pdfs/", import.meta.url));

export interface DatabaseConfig {
  databaseUrl: string;
  /** Nombre de composantes des vecteurs stockés dans chunks.embedding. */
  embeddingDimension: number;
}

/** Config nécessaire pour parler à la base (migrations, ingestion, recherche). */
export function loadDatabaseConfig(): DatabaseConfig {
  loadDotEnv();
  requireEnv(["DATABASE_URL", "EMBEDDING_DIMENSION"]);

  return {
    databaseUrl: process.env["DATABASE_URL"]!.trim(),
    embeddingDimension: parseDimension(process.env["EMBEDDING_DIMENSION"]!),
  };
}

/** Config nécessaire pour appeler le fournisseur d'embeddings. */
export function loadEmbeddingConfig(): EmbeddingClientOptions {
  loadDotEnv();
  requireEnv(["EMBEDDING_PROVIDER", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIMENSION"]);

  return {
    provider: process.env["EMBEDDING_PROVIDER"]!.trim(),
    apiKey: process.env["EMBEDDING_API_KEY"]!.trim(),
    model: process.env["EMBEDDING_MODEL"]!.trim(),
    dimension: parseDimension(process.env["EMBEDDING_DIMENSION"]!),
  };
}

/**
 * Recherche utilisée par défaut (RAG_SEARCH_MODE). Variable optionnelle :
 * absente, c'est "vector", le comportement d'avant la recherche hybride.
 */
export function loadSearchMode(): SearchMode {
  loadDotEnv();
  const raw = process.env["RAG_SEARCH_MODE"]?.trim() || "vector";
  if (!(SEARCH_MODES as readonly string[]).includes(raw)) {
    throw new ConfigError(`RAG_SEARCH_MODE doit valoir ${SEARCH_MODES.join(", ")} (reçu : "${raw}").`);
  }
  return raw as SearchMode;
}

function parseDimension(raw: string): number {
  const value = Number(raw.trim());
  // pgvector accepte jusqu'à 16 000 dimensions pour le type vector.
  if (!Number.isInteger(value) || value < 1 || value > 16_000) {
    throw new ConfigError(
      `EMBEDDING_DIMENSION doit être un entier entre 1 et 16000 (reçu : "${raw}").`,
    );
  }
  return value;
}
