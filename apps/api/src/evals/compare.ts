// npm run eval:compare -- <run A> <run B> [<run C>…]   (ex. 2026-10-14T10-00-00)
// Compare la recherche de plusieurs runs, sans notation manuelle : pour chaque
// question, le rang auquel le bon passage apparaît, calculé à partir des pages
// attendues de questions.json.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { type EvalQuestion, questionSchema, QUESTION_TYPES, QUESTIONS_FILE, type RunFile, RUNS_DIR, type Source } from "./types.js";

/** Le bon passage doit figurer dans les TOP premiers chunks (ceux que reçoit le modèle). */
const TOP = 5;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage : npm run eval:compare -- <run A> <run B> [<run C>…]");
    process.exitCode = 1;
    return;
  }

  const questions = z.array(questionSchema).parse(JSON.parse(await readFile(QUESTIONS_FILE, "utf8")));
  const runs = await Promise.all(args.map(loadRun));
  const labels = runs.map((_, i) => String.fromCharCode(65 + i)); // A, B, C…

  console.log("Runs");
  runs.forEach(({ id, run }, i) => {
    console.log(`  ${labels[i]}  ${id}  recherche ${modeOf(run).padEnd(7)}  commit ${run.config.commit}`);
  });
  warnIfNotComparable(runs.map((r) => r.run));

  // Seules les questions qui ont une réponse ont un « bon passage » à trouver.
  const answerable = questions.filter((q) => q.avec_reponse);
  const COL = 12;

  console.log(`\nRang du bon passage (« absent » : hors des ${TOP} chunks récupérés)\n`);
  console.log(`${"".padEnd(4)} ${"type".padEnd(12)} ${"pages attendues".padEnd(46)} ${labels.map((l) => l.padStart(COL)).join("")}`);

  const found = runs.map(() => new Set<string>());
  // Plus strict : toutes les sources attendues sont au 1er rang (combinaison : une au 1er, l'autre au 2e).
  const first = runs.map(() => new Set<string>());
  for (const question of answerable) {
    const cells = runs.map(({ run }, i) => {
      const result = run.resultats.find((r) => r.id === question.id);
      if (!result) return "—";
      if (result.erreur) return "erreur";
      const ranks = question.sources_attendues.map((source) => rankOf(source, result.chunks_recuperes));
      // Une question à plusieurs sources (combinaison) n'est trouvée que si toutes le sont.
      if (ranks.every((rank) => rank !== null && rank <= TOP)) found[i]!.add(question.id);
      if ([...ranks].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)).every((rank, j) => rank === j + 1)) first[i]!.add(question.id);
      return ranks.map((rank) => (rank === null ? "absent" : String(rank))).join(" + ");
    });
    console.log(
      `${question.id.padEnd(4)} ${question.type.padEnd(12)} ${formatSources(question.sources_attendues).padEnd(46)} ` +
        cells.map((cell) => cell.padStart(COL)).join(""),
    );
  }

  console.log(`\nBon passage dans les ${TOP} premiers`);
  console.log(`${"".padEnd(17)} ${labels.map((l) => l.padStart(COL)).join("")}`);
  printTotals("total", answerable, found);
  for (const type of QUESTION_TYPES) {
    const subset = answerable.filter((q) => q.type === type);
    if (subset.length > 0) printTotals(type, subset, found);
  }
  // Avec 13 chunks en base, 5 chunks en couvrent déjà une grande part : le
  // top 5 sature vite. Le 1er rang dit si le bon passage arrive en tête.
  console.log(`\nBon passage en tête (1er rang)`);
  printTotals("total", answerable, first);
  for (const type of QUESTION_TYPES) {
    const subset = answerable.filter((q) => q.type === type);
    if (subset.length > 0) printTotals(type, subset, first);
  }

  const skipped = questions.length - answerable.length;
  if (skipped > 0) console.log(`\n${skipped} question(s) sans réponse ignorée(s) : il n'y a pas de passage à trouver.`);

  function printTotals(label: string, subset: EvalQuestion[], foundByRun: Set<string>[]): void {
    const cells = foundByRun.map((set) => `${subset.filter((q) => set.has(q.id)).length}/${subset.length}`);
    console.log(`  ${label.padEnd(15)} ${cells.map((cell) => cell.padStart(COL)).join("")}`);
  }
}

/**
 * Rang du premier chunk qui contient la source attendue : même fichier, et au
 * moins une page en commun. null si aucun chunk récupéré ne la couvre.
 */
function rankOf(expected: Source, chunks: RunFile["resultats"][number]["chunks_recuperes"]): number | null {
  const match = chunks
    .filter((chunk) => chunk.fichier === expected.fichier && chunk.pages.some((page) => expected.pages.includes(page)))
    .sort((a, b) => a.rang - b.rang)[0];
  return match?.rang ?? null;
}

async function loadRun(arg: string): Promise<{ id: string; run: RunFile }> {
  // Accepte l'identifiant seul ou le chemin de n'importe quel fichier du run.
  const id = path.basename(arg).replace(/(\.notes)?\.(json|md)$/, "");
  return { id, run: JSON.parse(await readFile(`${RUNS_DIR}${id}.json`, "utf8")) as RunFile };
}

/** Les runs d'avant la recherche hybride n'enregistraient pas de mode : ils étaient vectoriels. */
function modeOf(run: RunFile): string {
  return run.config.recherche?.mode ?? "vector";
}

/**
 * Seule la recherche doit différer entre les runs comparés. Le modèle et
 * l'effort n'influencent pas les chunks récupérés : ils ne sont pas vérifiés.
 */
function warnIfNotComparable(runs: RunFile[]): void {
  const checks: [string, (run: RunFile) => unknown][] = [
    ["questions", (run) => run.config.sha256_questions],
    ["documents", (run) => run.config.documents],
    ["embeddings", (run) => run.config.embeddings],
    ["découpage", (run) => run.config.decoupage],
    ["k", (run) => run.config.k],
  ];
  const differing = checks
    .filter(([, read]) => new Set(runs.map((run) => JSON.stringify(read(run)))).size > 1)
    .map(([name]) => name);
  if (differing.length > 0) {
    console.log(`\n⚠ Les runs diffèrent aussi par : ${differing.join(", ")}. La comparaison ne mesure pas que la recherche.`);
  }
}

function formatSources(sources: Source[]): string {
  return sources
    .map((s) => `${s.fichier.replace(/\.pdf$/, "")} p. ${s.pages.join("–")}`)
    .join(" + ");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
