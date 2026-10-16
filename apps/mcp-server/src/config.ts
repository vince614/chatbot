import { fileURLToPath } from "node:url";

import { type DatabaseConfig, loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode } from "@chatbot/rag/config";
import type { EmbeddingClientOptions } from "@chatbot/rag/embeddings/index";
import { loadDotEnv } from "@chatbot/rag/env";
import type { SearchMode } from "@chatbot/rag/retrieve";
import { requireUser, type User } from "@chatbot/rag/users";

/**
 * La configuration du serveur MCP. Il partage avec l'API son .env (base,
 * clé Voyage) et son annuaire d'utilisateurs : une seule copie de chaque
 * secret. Les chemins sont relatifs à ce fichier, donc identiques depuis
 * src/ et depuis dist/ (même profondeur).
 */
const API_DIR = new URL("../../api/", import.meta.url);
const ENV_FILE = fileURLToPath(new URL(".env", API_DIR));
const USERS_FILE = fileURLToPath(new URL("data/users.json", API_DIR));

export interface McpConfig {
  user: User;
  database: DatabaseConfig;
  embedding: EmbeddingClientOptions;
  searchMode: SearchMode;
}

/**
 * Lit tout ce dont le serveur a besoin, ou lance une ConfigError. L'identité
 * d'abord : sans utilisateur valide, inutile d'aller plus loin.
 */
export async function loadMcpConfig(): Promise<McpConfig> {
  loadDotEnv(ENV_FILE);
  // MCP_USER_ID vient de l'environnement du processus (Inspector, .mcp.json),
  // jamais d'un argument d'outil : l'identité est fixée au lancement.
  const user = await requireUser(USERS_FILE, process.env["MCP_USER_ID"]?.trim() || undefined, "MCP_USER_ID");
  return {
    user,
    database: loadDatabaseConfig(),
    embedding: loadEmbeddingConfig(),
    searchMode: loadSearchMode(),
  };
}
