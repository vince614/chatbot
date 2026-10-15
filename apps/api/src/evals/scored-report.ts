import { writeFile } from "node:fs/promises";

import { renderQuestion } from "./report.js";
import { CRITERIA, formatTotal, type ScoresFile } from "./scoring.js";
import { type EvalQuestion, type RunFile, RUNS_DIR } from "./types.js";

/**
 * Le rapport de npm run eval (<run>.md) : les totaux d'abord, puis les échecs
 * avec leur raison, puis le détail attendu / obtenu de chaque question.
 * Il remplace le rapport « à noter » écrit par eval:run ; le fichier
 * <run>.notes.json reste disponible pour une notation manuelle.
 */
export async function writeScoredReport(run: RunFile, scores: ScoresFile, questions: EvalQuestion[]): Promise<string> {
  const file = `${RUNS_DIR}${scores.run}.md`;
  await writeFile(file, renderScoredReport(run, scores, questions));
  return file;
}

function renderScoredReport(run: RunFile, scores: ScoresFile, questions: EvalQuestion[]): string {
  const { config } = run;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const header = `| | ${CRITERIA.join(" | ")} |\n| --- | ${CRITERIA.map(() => "---").join(" | ")} |`;

  const failures = scores.questions.flatMap((q) =>
    CRITERIA.flatMap((criterion) => {
      const grade = q.notes[criterion];
      if (!grade || grade.score >= 1) return [];
      const label = criterion === "exactitude" ? `exactitude ${String(grade.score).replace(".", ",")}` : criterion;
      return [`- **${q.id}** (${q.type}) · **${label}** : ${grade.raison.replace(/\s+/g, " ")}`];
    }),
  );

  return [
    `# Run ${scores.run}`,
    "",
    `Modèle ${config.llm.modele} (effort ${config.llm.effort}) · juge ${scores.juge.modele} (grille ${scores.juge.grille}) ·`,
    `embeddings ${config.embeddings.modele} · recherche ${config.recherche?.mode ?? "vector"} · k = ${config.k} ·`,
    `chunks de ${config.decoupage.tokens_par_chunk} tokens · utilisateur ${config.utilisateur?.id ?? "—"} · commit ${config.commit}`,
    "",
    "## Scores",
    "",
    "Chaque critère est compté sur les questions où il s'applique : recherche, citation et exactitude sur",
    "les questions avec réponse, abstention sur toutes. Exactitude : correct 1, partiel 0,5, incorrect 0.",
    "",
    header,
    `| **total** | ${CRITERIA.map((c) => `**${formatTotal(scores.totaux[c])}**`).join(" | ")} |`,
    ...Object.entries(scores.par_type).map(
      ([type, totals]) => `| ${type} | ${CRITERIA.map((c) => formatTotal(totals[c])).join(" | ")} |`,
    ),
    "",
    `## Échecs (${failures.length})`,
    "",
    ...(failures.length > 0 ? failures : ["Aucun."]),
    "",
    "## Détail par question",
    "",
    ...run.resultats.map((result) => renderQuestion(result, byId.get(result.id))),
  ].join("\n");
}
