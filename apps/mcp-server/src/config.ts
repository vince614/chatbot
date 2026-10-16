import { fileURLToPath } from "node:url";

import { type DatabaseConfig, loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode } from "@chatbot/rag/config";
import type { EmbeddingClientOptions } from "@chatbot/rag/embeddings/index";
import { ConfigError, loadDotEnv } from "@chatbot/rag/env";
import { loadMcpTokens, type McpToken } from "@chatbot/rag/mcp-tokens";
import type { SearchMode } from "@chatbot/rag/retrieve";
import { loadUsers, requireUser, type User } from "@chatbot/rag/users";

/**
 * La configuration du serveur MCP. Il partage avec l'API son .env (base,
 * clé Voyage) et son annuaire d'utilisateurs : une seule copie de chaque
 * secret. Les chemins sont relatifs à ce fichier, donc identiques depuis
 * src/ et depuis dist/ (même profondeur).
 */
const API_DIR = new URL("../../api/", import.meta.url);
const ENV_FILE = fileURLToPath(new URL(".env", API_DIR));
export const USERS_FILE = fileURLToPath(new URL("data/users.json", API_DIR));
export const TOKENS_FILE = fileURLToPath(new URL("data/mcp-tokens.json", API_DIR));

export const TRANSPORTS = ["stdio", "http"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** Port HTTP par défaut : ni l'API (3000), ni Vite (5173). */
const DEFAULT_HTTP_PORT = 3100;

/** Ce qui ne dépend pas du transport : la base, Voyage, le mode de recherche. */
export interface McpConfig {
  database: DatabaseConfig;
  embedding: EmbeddingClientOptions;
  searchMode: SearchMode;
}

/** Lit la configuration commune aux deux transports, ou lance une ConfigError. */
export function loadMcpConfig(): McpConfig {
  loadDotEnv(ENV_FILE);
  return {
    database: loadDatabaseConfig(),
    embedding: loadEmbeddingConfig(),
    searchMode: loadSearchMode(),
  };
}

/**
 * stdio : l'utilisateur vient de l'environnement du processus (Inspector,
 * .mcp.json, l'API), jamais d'un argument d'outil. Il est fixé au lancement.
 */
export function loadStdioUser(): Promise<User> {
  loadDotEnv(ENV_FILE);
  return requireUser(USERS_FILE, process.env["MCP_USER_ID"]?.trim() || undefined, "MCP_USER_ID");
}

/**
 * http : les jetons et leurs utilisateurs. MCP_USER_ID n'est pas lu :
 * l'identité vient de chaque requête, pas du processus.
 */
export async function loadHttpTokens(): Promise<McpToken[]> {
  return loadMcpTokens(TOKENS_FILE, await loadUsers(USERS_FILE));
}

/** http : le port d'écoute (MCP_HTTP_PORT, 3100 par défaut). */
export function loadHttpPort(): number {
  loadDotEnv(ENV_FILE);
  const raw = process.env["MCP_HTTP_PORT"]?.trim() || String(DEFAULT_HTTP_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`MCP_HTTP_PORT doit être un port entre 1 et 65535 (reçu : "${raw}").`);
  }
  return port;
}

/** --transport stdio|http (stdio par défaut : c'est ce qu'attendent .mcp.json et l'API). */
export function parseTransport(argv: readonly string[]): Transport {
  const index = argv.indexOf("--transport");
  const raw = index === -1 ? "stdio" : argv[index + 1];
  if (!(TRANSPORTS as readonly (string | undefined)[]).includes(raw)) {
    throw new ConfigError(`--transport doit valoir ${TRANSPORTS.join(" ou ")} (reçu : "${raw ?? ""}").`);
  }
  return raw as Transport;
}
