import type { EvalQuestion, RunResult, Source } from "../types.js";
import { type CodeGrader, covers, formatSource } from "./types.js";

/** Le bon passage doit figurer dans les TOP premiers chunks : ceux que reçoit le modèle. */
export const TOP = 5;

/**
 * Pour chaque source attendue, le rang du premier chunk récupéré qui la
 * couvre ; null si aucun. Utilisé aussi par eval:compare pour afficher les rangs.
 */
export function expectedRanks(question: EvalQuestion, result: RunResult): (number | null)[] {
  return question.sources_attendues.map((expected) => rankOf(expected, result.chunks_recuperes));
}

function rankOf(expected: Source, chunks: RunResult["chunks_recuperes"]): number | null {
  const match = chunks.filter((chunk) => covers(chunk, expected)).sort((a, b) => a.rang - b.rang)[0];
  return match?.rang ?? null;
}

/**
 * recherche : le bon passage est-il dans les TOP chunks récupérés ? Une
 * question à plusieurs sources (combinaison) n'est réussie que si toutes y
 * sont. Sans réponse attendue, il n'y a rien à trouver : non applicable.
 */
export const gradeRecherche: CodeGrader = (question, result) => {
  if (!question.avec_reponse) return null;
  if (result.erreur) return { score: 0, raison: "question en erreur, aucun chunk récupéré" };

  const ranks = expectedRanks(question, result);
  const missing = question.sources_attendues.filter((_, i) => ranks[i] === null || ranks[i]! > TOP);
  if (missing.length > 0) {
    return { score: 0, raison: `absent des ${TOP} premiers : ${missing.map(formatSource).join(", ")}` };
  }
  return { score: 1, raison: `bon passage au rang ${ranks.join(" + ")}` };
};
