import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import type { LlmClientOptions } from "./llm/index.js";

export interface Config {
  port: number;
  llm: LlmClientOptions;
}

/** Erreur de configuration : le message est destiné à être affiché tel quel. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const REQUIRED_VARS = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL"] as const;

/** Chemin de apps/api/.env, indépendant du répertoire courant. */
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

/**
 * Charge apps/api/.env (s'il existe) dans process.env, puis vérifie que les
 * variables obligatoires sont présentes. Lance une ConfigError sinon.
 */
export function loadConfig(): Config {
  try {
    loadEnvFile(ENV_FILE);
  } catch (error) {
    // Fichier absent : on tolère, les variables peuvent venir de l'environnement.
    if (!isFileNotFound(error)) throw error;
  }

  const missing = REQUIRED_VARS.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      [
        `Variable(s) d'environnement manquante(s) : ${missing.join(", ")}.`,
        `Copie apps/api/.env.example vers apps/api/.env et renseigne les valeurs.`,
        `Fichier attendu : ${ENV_FILE}`,
      ].join("\n"),
    );
  }

  return {
    port: Number(process.env["PORT"] ?? 3000),
    llm: {
      provider: process.env["LLM_PROVIDER"]!.trim(),
      apiKey: process.env["LLM_API_KEY"]!.trim(),
      model: process.env["LLM_MODEL"]!.trim(),
    },
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
