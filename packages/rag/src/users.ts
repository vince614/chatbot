import { readFile } from "node:fs/promises";

import { z } from "zod";

import { groupSchema } from "./acl.js";
import { ConfigError } from "./env.js";

/**
 * Les utilisateurs fictifs de l'exercice (apps/api/data/users.json) et leurs
 * groupes. Ce fichier tient lieu d'annuaire : en production, les groupes
 * viendraient du fournisseur d'identité (voir apps/api/src/auth/fake-identity.ts).
 * L'application donne le chemin du fichier.
 */

const userSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "identifiant invalide (minuscules, chiffres, - ou _)"),
  nom: z.string().min(1),
  groupes: z.array(groupSchema),
});
export type User = z.infer<typeof userSchema>;

const usersSchema = z.array(userSchema).refine((users) => new Set(users.map((u) => u.id)).size === users.length, {
  message: "identifiant en double",
});

/** Les utilisateurs, par identifiant. Fichier absent ou invalide : ConfigError. */
export async function loadUsers(file: string): Promise<Map<string, User>> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`Utilisateurs illisibles (${file}) : ${error instanceof Error ? error.message : error}`);
  }
  const parsed = usersSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`Utilisateurs invalides (${file}) : ${z.prettifyError(parsed.error)}`);
  return new Map(parsed.data.map((user) => [user.id, user]));
}

/**
 * L'utilisateur demandé, ou une ConfigError qui liste les identifiants connus.
 * `source` nomme d'où vient l'identifiant dans le message : « --user » pour un
 * script, « MCP_USER_ID » pour le serveur MCP.
 */
export async function requireUser(file: string, id: string | undefined, source = "--user"): Promise<User> {
  const users = await loadUsers(file);
  const user = id === undefined ? undefined : users.get(id);
  if (!user) {
    const known = [...users.keys()].join(", ");
    throw new ConfigError(
      id === undefined ? `${source} est obligatoire (${known}).` : `Utilisateur inconnu : « ${id} » (${known}).`,
    );
  }
  return user;
}
