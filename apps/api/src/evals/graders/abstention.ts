import type { CodeGrader } from "./types.js";

/**
 * La formule exigée par la règle 3 du prompt RAG. On la cherche dans un texte
 * normalisé : le modèle écrit aussi bien « **Je ne sais pas.** » que « Je ne
 * sais pas. ».
 */
const ABSTENTION = "je ne sais pas";

/** Minuscules, sans balisage Markdown (* _ `), apostrophes et espaces uniformisés. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * abstention : le modèle sait-il se taire, et seulement quand il le faut ?
 * - sans réponse attendue : « Je ne sais pas » ET aucune source citée (citer
 *   un passage, c'est prétendre qu'il répond) ;
 * - avec réponse attendue : pas de « Je ne sais pas ».
 * S'applique aux 20 questions.
 */
export const gradeAbstention: CodeGrader = (question, result) => {
  if (result.erreur || result.reponse_obtenue === null) return { score: 0, raison: "pas de réponse (erreur)" };
  const abstains = normalize(result.reponse_obtenue).includes(ABSTENTION);
  const citations = result.sources_citees.length;

  if (question.avec_reponse) {
    return abstains
      ? { score: 0, raison: "dit « Je ne sais pas » alors que la réponse est dans les documents" }
      : { score: 1, raison: "répond sans s'abstenir" };
  }
  if (!abstains) return { score: 0, raison: "ne dit pas « Je ne sais pas » à une question sans réponse" };
  if (citations > 0) return { score: 0, raison: `dit « Je ne sais pas » mais cite ${citations} source(s)` };
  return { score: 1, raison: "s'abstient sans citer de source" };
};
