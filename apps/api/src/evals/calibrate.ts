// npm run eval:calibrate -- <run> [--repeat 2]
// Compare les verdicts du juge (exactitude) aux notes manuelles « reponse »
// de <run>.notes.json : taux d'accord et liste des désaccords. Avec --repeat 2,
// le juge note chaque question deux fois : on mesure aussi son propre bruit.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { ConfigError } from "../config.js";
import { loadQuestions, loadRun } from "./files.js";
import { createJudge, JUDGE_PROMPT_VERSION, type Verdict } from "./graders/exactitude.js";
import { gradeCitation } from "./graders/citation.js";
import type { Notes } from "./report.js";
import { RUNS_DIR } from "./types.js";

interface Row {
  id: string;
  type: string;
  verdicts: (Verdict | null)[];
  justification: string;
  citation: 0 | 1;
  /** Note manuelle « reponse » : 1 si juste ET bien citée. null si non saisie. */
  manual: 0 | 1 | null;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { repeat: { type: "string", default: "1" } },
  });
  const repeat = Number(values.repeat);
  if (!positionals[0] || !Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
    console.error("Usage : npm run eval:calibrate -- <run> [--repeat 1|2|3]");
    process.exitCode = 1;
    return;
  }

  const { id, run } = await loadRun(positionals[0]);
  const questions = new Map((await loadQuestions()).map((q) => [q.id, q]));
  const notes = await readNotes(id);
  const judge = createJudge();
  console.log(`Run ${id} · juge ${judge.model} (grille ${JUDGE_PROMPT_VERSION}, température 0) · ${repeat} passage(s)\n`);

  const rows: Row[] = [];
  for (const result of run.resultats) {
    const question = questions.get(result.id)!;
    if (!question.avec_reponse) continue; // le juge ne s'applique pas : abstention suffit
    const verdicts: (Verdict | null)[] = [];
    let justification = "";
    for (let i = 0; i < repeat; i++) {
      const grade = await judge.grade(question, result);
      verdicts.push(grade?.verdict ?? null);
      justification ||= grade?.raison ?? "";
    }
    rows.push({
      id: result.id,
      type: result.type,
      verdicts,
      justification,
      citation: gradeCitation(question, result)?.score === 1 ? 1 : 0,
      manual: notes?.[result.id]?.reponse ?? null,
    });
    const v = verdicts.map((x) => x ?? "erreur").join(" / ");
    console.log(`${result.id} ${result.type.padEnd(12)} juge ${v.padEnd(22)} citation ${rows.at(-1)!.citation}  manuel ${rows.at(-1)!.manual ?? "—"}`);
  }

  // Les verdicts sont gardés à côté du run pour pouvoir les relire.
  await writeFile(`${RUNS_DIR}${id}.judge.json`, `${JSON.stringify({ juge: judge.model, grille: JUDGE_PROMPT_VERSION, verdicts: rows }, null, 2)}\n`);

  if (repeat > 1) {
    const stable = rows.filter((r) => new Set(r.verdicts).size === 1).length;
    console.log(`\nStabilité du juge : ${stable}/${rows.length} questions avec le même verdict à chaque passage.`);
  }

  const noted = rows.filter((r) => r.manual !== null);
  if (noted.length === 0) {
    console.log(`\nAucune note « reponse » saisie dans ${id}.notes.json : calibration impossible pour l'instant.`);
    return;
  }

  // Trois façons de traduire le verdict en 0/1 pour le comparer à la note manuelle.
  const first = (r: Row) => r.verdicts[0];
  const readings: [string, (r: Row) => 0 | 1][] = [
    ["strict    (correct = 1)", (r) => (first(r) === "correct" ? 1 : 0)],
    ["indulgent (correct ou partiel = 1)", (r) => (first(r) === "correct" || first(r) === "partiel" ? 1 : 0)],
    // La note manuelle exigeait « juste ET cite la bonne source » : c'est la lecture la plus comparable.
    ["juge + citation (correct et bien cité = 1)", (r) => (first(r) === "correct" && r.citation === 1 ? 1 : 0)],
  ];
  console.log(`\nAccord avec tes notes (${noted.length} questions avec réponse notées)`);
  for (const [label, read] of readings) {
    const agree = noted.filter((r) => read(r) === r.manual).length;
    console.log(`  ${label.padEnd(44)} ${agree}/${noted.length}  (${Math.round((100 * agree) / noted.length)} %)`);
  }

  const [, combined] = readings[2]!;
  const disagreements = noted.filter((r) => combined(r) !== r.manual);
  console.log(`\nDésaccords, lecture « juge + citation » (${disagreements.length})`);
  for (const r of disagreements) {
    console.log(`  ${r.id} ${r.type.padEnd(12)} manuel ${r.manual} · juge ${first(r)} · citation ${r.citation}`);
    console.log(`       ${r.justification}`);
  }
}

async function readNotes(id: string): Promise<Notes | null> {
  try {
    return JSON.parse(await readFile(`${RUNS_DIR}${id}.notes.json`, "utf8")) as Notes;
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
