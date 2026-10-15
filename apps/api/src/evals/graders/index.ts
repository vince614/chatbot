import type { EvalQuestion, RunFile } from "../types.js";
import { gradeAbstention } from "./abstention.js";
import { gradeCitation } from "./citation.js";
import { gradeRecherche } from "./recherche.js";
import type { CodeGrader, Grade } from "./types.js";

export type { CodeGrader, Grade } from "./types.js";

/** Les graders par code, dans l'ordre d'affichage. Ajouter un critère = ajouter une ligne. */
export const CODE_GRADERS = {
  recherche: gradeRecherche,
  citation: gradeCitation,
  abstention: gradeAbstention,
} satisfies Record<string, CodeGrader>;

export type Criterion = keyof typeof CODE_GRADERS;

/** Les notes d'une question : un Grade par critère, null si non applicable. */
export interface QuestionGrades {
  id: string;
  type: EvalQuestion["type"];
  grades: Record<Criterion, Grade | null>;
}

/** Applique tous les graders par code à un run. Une question absente de questions.json est une erreur. */
export function gradeRun(run: RunFile, questions: EvalQuestion[]): QuestionGrades[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return run.resultats.map((result) => {
    const question = byId.get(result.id);
    if (!question) throw new Error(`${result.id} est dans le run mais plus dans questions.json.`);
    const grades = Object.fromEntries(
      Object.entries(CODE_GRADERS).map(([name, grader]) => [name, grader(question, result)]),
    ) as Record<Criterion, Grade | null>;
    return { id: result.id, type: result.type, grades };
  });
}
