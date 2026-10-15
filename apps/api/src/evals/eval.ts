// npm run eval -- --user <id> [--mode vector|lexical|hybrid] [--only q01,q13]
// Toute l'évaluation en une commande : le run (questions → réponses), puis
// les graders par code et le juge, puis le rapport et l'historique.
import { ConfigError } from "../config.js";
import { loadQuestions, loadRun } from "./files.js";
import { createJudge } from "./graders/exactitude.js";
import { executeRun } from "./run.js";
import { writeScoredReport } from "./scored-report.js";
import { appendHistory, CRITERIA, formatTotal, HISTORY_FILE, scoreRun, writeScores } from "./scoring.js";

async function main(): Promise<void> {
  // Le juge est construit d'abord : une configuration invalide échoue avant
  // dix minutes de run, pas après.
  const judge = createJudge();

  const runId = await executeRun(process.argv.slice(2));
  if (runId === null) return;

  const { run } = await loadRun(runId);
  const questions = await loadQuestions();
  console.log(`\nNotation (juge ${judge.model})`);
  const scores = await scoreRun(runId, run, questions, judge);

  const scoresFile = await writeScores(scores);
  const report = await writeScoredReport(run, scores, questions);
  // L'historique ne reçoit que des runs complets et sans erreur : un run
  // partiel (--only) ou abîmé (quota, crédit, réseau, juge) ne se compare pas
  // aux autres, et une ligne ajoutée n'est jamais réécrite.
  const partial = run.resultats.length < questions.length;
  const runErrors = run.resultats.filter((r) => r.erreur).length;
  const judgeErrors = scores.questions.filter((q) => q.notes.exactitude?.raison.startsWith("erreur du juge")).length;
  const excluded = partial
    ? "run partiel (--only)"
    : runErrors + judgeErrors > 0
      ? `${runErrors} question(s) en erreur, ${judgeErrors} erreur(s) du juge`
      : null;
  if (excluded === null) await appendHistory(run, scores);

  console.log(`\n${CRITERIA.map((c) => `${c} ${formatTotal(scores.totaux[c])}`).join(" · ")}`);
  console.log(`Scores    : ${scoresFile}`);
  console.log(`Rapport   : ${report}`);
  console.log(excluded ? `Historique : non ajouté (${excluded}).` : `Historique : ${HISTORY_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
