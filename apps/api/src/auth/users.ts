import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ConfigError } from "../config.js";
import { groupSchema } from "../rag/acl.js";

/**
 * Les utilisateurs fictifs de l'exercice (data/users.json) et leurs groupes.
 * Ce fichier tient lieu d'annuaire : en production, les groupes viendraient du
 * fournisseur d'identité (voir auth/fake-identity.ts à l'étape 3).
 */

export const USERS_FILE = fileURLToPath(new URL("../../data/users.json", import.meta.url));

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
export async function loadUsers(file = USERS_FILE): Promise<Map<string, User>> {
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

/** L'utilisateur demandé par un script (--user), ou une ConfigError qui liste les identifiants connus. */
export async function requireUser(id: string | undefined): Promise<User> {
  const users = await loadUsers();
  const user = id === undefined ? undefined : users.get(id);
  if (!user) {
    const known = [...users.keys()].join(", ");
    throw new ConfigError(
      id === undefined ? `--user est obligatoire (${known}).` : `Utilisateur inconnu : « ${id} » (${known}).`,
    );
  }
  return user;
}
