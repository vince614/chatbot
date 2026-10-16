import { loadEnvFile } from "node:process";

/**
 * Lecture de l'environnement, commune aux applications qui utilisent le RAG.
 * Le package ne sait pas où se trouve le fichier .env : c'est l'application
 * qui le lui donne (loadDotEnv), puis les fonctions load*Config lisent
 * process.env.
 */

/** Erreur de configuration : le message est destiné à être affiché tel quel. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Dernier fichier .env lu, cité dans les messages d'erreur. */
let envFile: string | undefined;

/** Charge un fichier .env dans process.env. Un fichier absent est toléré. */
export function loadDotEnv(file: string): void {
  envFile = file;
  try {
    loadEnvFile(file);
  } catch (error) {
    // Fichier absent : on tolère, les variables peuvent venir de l'environnement.
    if (!isFileNotFound(error)) throw error;
  }
}

/** Lance une ConfigError listant les variables absentes ou vides. */
export function requireEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      [
        `Variable(s) d'environnement manquante(s) : ${missing.join(", ")}.`,
        envFile
          ? `Renseigne-les dans ${envFile} (modèle : .env.example à côté).`
          : "Aucun fichier .env n'a été lu : renseigne-les dans l'environnement.",
      ].join("\n"),
    );
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
