// npm run eval:grade -- <run>   (ex. 2026-10-15T11-00-00)
// Note un run existant avec les graders par code : aucun appel à un modèle,
// donc instantané, gratuit et reproductible.
import { loadQuestions, loadRun } from "./files.js";
import { CODE_GRADERS, type Criterion, gradeRun, type QuestionGrades } from "./graders/index.js";
import { QUESTION_TYPES } from "./types.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage : npm run eval:grade -- <run>   (ex. 2026-10-15T11-00-00)");
    process.exitCode = 1;
    return;
  }

  const { id, run } = await loadRun(arg);
  const rows = gradeRun(run, await loadQuestions());
  const criteria = Object.keys(CODE_GRADERS) as Criterion[];
  const COL = 12;

  console.log(`Run ${id} · recherche ${run.config.recherche?.mode ?? "vector"} · utilisateur ${run.config.utilisateur?.id ?? "—"}\n`);
  console.log(`${"".padEnd(4)} ${"type".padEnd(13)}${criteria.map((c) => c.padStart(COL)).join("")}`);
  for (const row of rows) {
    // ✓ réussi, ✗ échoué, — non applicable.
    const cells = criteria.map((c) => {
      const grade = row.grades[c];
      return (grade === null ? "—" : grade.score === 1 ? "✓" : "✗").padStart(COL);
    });
    console.log(`${row.id.padEnd(4)} ${row.type.padEnd(13)}${cells.join("")}`);
  }

  console.log(`\nTotaux (sur les questions où le critère s'applique)`);
  printTotals("total", rows);
  for (const type of QUESTION_TYPES) {
    const subset = rows.filter((r) => r.type === type);
    if (subset.length > 0) printTotals(type, subset);
  }

  const failures = rows.flatMap((row) =>
    criteria.flatMap((c) => {
      const grade = row.grades[c];
      return grade && grade.score < 1 ? [`  ${row.id} ${c.padEnd(11)} ${grade.raison}`] : [];
    }),
  );
  console.log(`\nÉchecs (${failures.length})`);
  for (const line of failures) console.log(line);

  function printTotals(label: string, subset: QuestionGrades[]): void {
    const cells = criteria.map((c) => {
      const graded = subset.map((r) => r.grades[c]).filter((g) => g !== null);
      if (graded.length === 0) return "—".padStart(COL);
      return `${graded.reduce((sum, g) => sum + g.score, 0)}/${graded.length}`.padStart(COL);
    });
    console.log(`  ${label.padEnd(15)}${cells.join("")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
