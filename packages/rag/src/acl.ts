import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ConfigError } from "./env.js";

/**
 * Les droits d'accès aux documents : data/pdfs/acl.json associe chaque nom de
 * fichier (relatif à data/pdfs/, comme documents.file_name) à la liste des
 * groupes autorisés à le lire.
 *
 *   { "reglement-interieur.pdf": ["rh"], "discordinvites.pdf": ["tech"] }
 *
 * Refus par défaut : un PDF absent de l'ACL, ou associé à une liste vide,
 * n'est visible par personne. Rien n'est jamais public par défaut.
 */

/** Un nom de groupe : lettres, chiffres, « - » et « _ » (pas d'espace parasite, pas de casse ambiguë). */
export const groupSchema = z.string().regex(/^[a-z0-9_-]+$/, "groupe invalide (attendu : minuscules, chiffres, - ou _)");

const aclSchema = z.record(z.string().min(1), z.array(groupSchema));

/** Nom de fichier → groupes autorisés (triés, sans doublon). */
export type Acl = Map<string, string[]>;

/**
 * Lit et valide l'ACL. Un fichier absent ou invalide est une ConfigError : la
 * lecture échoue avant toute écriture, plutôt que de retirer en silence les
 * droits de tous les documents à cause d'une faute de frappe.
 */
export async function loadAcl(file: string): Promise<Acl> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`ACL introuvable : ${file}. Copie acl.example.json en acl.json et renseigne les groupes.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`ACL invalide (${file}) : JSON mal formé (${error instanceof Error ? error.message : error}).`);
  }

  const parsed = aclSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`ACL invalide (${file}) : ${z.prettifyError(parsed.error)}`);
  }

  // Triés et dédoublonnés : deux listes égales s'écrivent pareil, et la base
  // ne voit un changement que s'il y en a vraiment un.
  return new Map(Object.entries(parsed.data).map(([fileName, groups]) => [fileName, [...new Set(groups)].sort()]));
}
