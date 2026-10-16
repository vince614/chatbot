import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ConfigError } from "./env.js";
import type { User } from "./users.js";

/**
 * Les jetons du serveur MCP en HTTP (apps/api/data/mcp-tokens.json, ignoré
 * par git) : { "<jeton>": "<identifiant utilisateur>" }, un jeton par
 * utilisateur. Le serveur MCP s'en sert pour savoir qui appelle ; l'API, pour
 * appeler au nom d'un utilisateur. L'application donne le chemin du fichier.
 *
 * Jeton statique, sans expiration ni révocation : c'est un exercice local
 * (voir docs/cours/jour-4-serveur-distant.md).
 */

/** 32 caractères au moins : `openssl rand -hex 32` en donne 64. Un jeton court se devine. */
const MIN_TOKEN_LENGTH = 32;

const tokensSchema = z.record(
  z.string().min(MIN_TOKEN_LENGTH, `un jeton fait au moins ${MIN_TOKEN_LENGTH} caractères`).regex(/^[A-Za-z0-9_-]+$/, "un jeton ne contient que lettres, chiffres, - et _"),
  z.string().min(1),
);

export interface McpToken {
  token: string;
  user: User;
}

/**
 * Les jetons, chacun avec son utilisateur résolu dans l'annuaire. Fichier
 * absent ou invalide, utilisateur inconnu, deux jetons pour un même
 * utilisateur : ConfigError. Les messages ne citent jamais un jeton.
 */
export async function loadMcpTokens(file: string, users: ReadonlyMap<string, User>): Promise<McpToken[]> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const hint = isFileNotFound(error) ? ` Copie ${file.replace(/\.json$/, ".example.json")} et remplace les jetons.` : "";
    throw new ConfigError(`Jetons MCP illisibles (${file}).${hint}`);
  }

  const parsed = tokensSchema.safeParse(json);
  if (!parsed.success) {
    // Le chemin d'une erreur Zod sur un record est la clé, c'est-à-dire le jeton : on ne le montre pas.
    // Une clé refusée donne « Invalid key in record » : la vraie raison est dans ses sous-erreurs.
    const messages = parsed.error.issues.flatMap((issue) =>
      issue.code === "invalid_key" ? issue.issues.map((inner) => inner.message) : [issue.message],
    );
    const reasons = [...new Set(messages)].join(" ; ");
    throw new ConfigError(`Jetons MCP invalides (${file}) : ${reasons}.`);
  }

  const tokens: McpToken[] = [];
  const seen = new Set<string>();
  for (const [token, userId] of Object.entries(parsed.data)) {
    const user = users.get(userId);
    if (!user) throw new ConfigError(`Jetons MCP (${file}) : utilisateur inconnu « ${userId} ».`);
    if (seen.has(userId)) throw new ConfigError(`Jetons MCP (${file}) : deux jetons pour « ${userId} », un seul attendu.`);
    seen.add(userId);
    tokens.push({ token, user });
  }
  return tokens;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
