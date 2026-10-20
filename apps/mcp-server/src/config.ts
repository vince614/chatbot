import { fileURLToPath } from "node:url";

import { type DatabaseConfig, loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode } from "@chatbot/rag/config";
import type { EmbeddingClientOptions } from "@chatbot/rag/embeddings/index";
import { ConfigError, loadDotEnv } from "@chatbot/rag/env";
import { loadIssuer, loadMcpHttpPort, loadMcpResource, SCOPES } from "@chatbot/rag/oauth";
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

export const TRANSPORTS = ["stdio", "http"] as const;
export type Transport = (typeof TRANSPORTS)[number];

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

/** http : ce qu'il faut pour être une ressource OAuth. */
export interface HttpConfig {
  port: number;
  /** Notre identifiant de ressource (RFC 8707), l'audience exigée dans les jetons. */
  resource: string;
  /** Le serveur d'autorisation dont on accepte les jetons. */
  issuer: string;
  jwksUrl: URL;
  requiredScope: string;
  users: Map<string, User>;
}

/**
 * http : MCP_USER_ID n'est pas lu, l'identité vient du jeton de chaque
 * requête. AUTH_JWKS_URL est optionnelle (<émetteur>/.well-known/jwks.json).
 */
export async function loadHttpConfig(): Promise<HttpConfig> {
  loadDotEnv(ENV_FILE);
  const issuer = loadIssuer();
  const rawJwks = process.env["AUTH_JWKS_URL"]?.trim() || `${issuer}/.well-known/jwks.json`;
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(rawJwks);
  } catch {
    throw new ConfigError(`AUTH_JWKS_URL n'est pas une URL (reçu : "${rawJwks}").`);
  }
  return {
    port: loadMcpHttpPort(),
    resource: loadMcpResource(),
    issuer,
    jwksUrl,
    requiredScope: SCOPES.documents,
    users: await loadUsers(USERS_FILE),
  };
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
