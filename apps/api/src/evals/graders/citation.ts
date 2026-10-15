import { type CodeGrader, covers, formatSource } from "./types.js";

/**
 * citation : au moins une source citée ([n]) correspond à une source
 * attendue (fichier et page). On ne demande pas que toutes soient citées :
 * une réponse juste peut s'appuyer sur un seul des passages attendus.
 * Sans réponse attendue : non applicable (c'est le rôle d'abstention).
 */
export const gradeCitation: CodeGrader = (question, result) => {
  if (!question.avec_reponse) return null;
  const cited = result.sources_citees;
  if (cited.length === 0) return { score: 0, raison: "aucune source citée" };

  const good = cited.find((source) => question.sources_attendues.some((expected) => covers(source, expected)));
  if (good) return { score: 1, raison: `cite ${formatSource(good)} [${good.index}]` };
  return {
    score: 0,
    raison:
      `cite ${cited.map(formatSource).join(", ")} ; ` +
      `attendu : ${question.sources_attendues.map(formatSource).join(" ou ")}`,
  };
};
