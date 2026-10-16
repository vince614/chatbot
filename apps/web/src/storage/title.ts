import type { StoredMessage } from "./types";

const MAX_TITLE_LENGTH = 60;
export const UNTITLED = "Nouvelle conversation";

/**
 * Le titre d'une conversation : son premier message utilisateur, sur une
 * ligne, coupé sur un mot vers 60 caractères. Pas d'appel au modèle pour
 * résumer : ce serait une requête de plus, qui enverrait le texte au serveur.
 */
export function deriveTitle(messages: readonly StoredMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = first?.content.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return UNTITLED;
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const cut = text.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // Un mot de plus de 30 caractères (une URL) : on coupe au milieu plutôt que de tout perdre.
  return `${(lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
