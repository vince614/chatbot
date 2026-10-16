import { fileURLToPath } from "node:url";

import * as rag from "@chatbot/rag/config";
import { loadDotEnv as loadEnvFile, requireEnv } from "@chatbot/rag/env";

import type { LlmClientOptions } from "./llm/index.js";

export { ConfigError } from "@chatbot/rag/env";

export interface Config {
  port: number;
  llm: LlmClientOptions;
}

const REQUIRED_VARS = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL"] as const;

/** Chemin de apps/api/.env, indépendant du répertoire courant. */
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

/**
 * Charge apps/api/.env (s'il existe) dans process.env, puis vérifie que les
 * variables obligatoires sont présentes. Lance une ConfigError sinon.
 */
export function loadConfig(): Config {
  loadDotEnv();
  requireEnv(REQUIRED_VARS);

  return {
    port: Number(process.env["PORT"] ?? 3000),
    llm: {
      provider: process.env["LLM_PROVIDER"]!.trim(),
      apiKey: process.env["LLM_API_KEY"]!.trim(),
      model: process.env["LLM_MODEL"]!.trim(),
    },
  };
}

/** Charge apps/api/.env dans process.env. Un fichier absent est toléré. */
export function loadDotEnv(): void {
  loadEnvFile(ENV_FILE);
}

/** Dossier où tu déposes les PDF à ingérer (apps/api/data/pdfs/), indépendant du répertoire courant. */
export const PDF_DIR = fileURLToPath(new URL("../data/pdfs/", import.meta.url));

/** Les droits d'accès aux PDF (voir @chatbot/rag/acl). */
export const ACL_FILE = `${PDF_DIR}acl.json`;

/** L'annuaire des utilisateurs fictifs (voir @chatbot/rag/users). */
export const USERS_FILE = fileURLToPath(new URL("../data/users.json", import.meta.url));

/*
 * La configuration du RAG vit dans @chatbot/rag ; l'API charge d'abord son
 * propre .env, puis la lit.
 */

export function loadDatabaseConfig(): rag.DatabaseConfig {
  loadDotEnv();
  return rag.loadDatabaseConfig();
}

export function loadEmbeddingConfig(): ReturnType<typeof rag.loadEmbeddingConfig> {
  loadDotEnv();
  return rag.loadEmbeddingConfig();
}

export function loadSearchMode(): ReturnType<typeof rag.loadSearchMode> {
  loadDotEnv();
  return rag.loadSearchMode();
}
