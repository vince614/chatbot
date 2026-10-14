// npm run eval:score -- <run>      (ex. 2026-10-13T16-10-00, ou le chemin d'un des fichiers du run)
// Additionne les notes saisies à la main dans <run>.notes.json.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Notes } from "./report.js";
import { QUESTION_TYPES, type RunFile, RUNS_DIR } from "./types.js";

const noteValue = z.union([z.literal(0), z.literal(1), z.null()]);
const notesSchema = z.record(
  z.string(),
  z.object({ recherche: noteValue, reponse: noteValue, commentaire: z.string().optional().default("") }),
);

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage : npm run eval:score -- <run>   (ex. 2026-10-13T16-10-00)");
    process.exitCode = 1;
    return;
  }

  // Accepte l'identifiant seul ou le chemin de n'importe quel fichier du run.
  const runId = path.basename(arg).replace(/(\.notes)?\.(json|md)$/, "");
  const run = JSON.parse(await readFile(`${RUNS_DIR}${runId}.json`, "utf8")) as RunFile;
  const notes: Notes = notesSchema.parse(JSON.parse(await readFile(`${RUNS_DIR}${runId}.notes.json`, "utf8")));

  const rows = run.resultats.map((r) => ({ ...r, note: notes[r.id] }));
  const total = rows.length;
  const sum = (key: "recherche" | "reponse", subset = rows) => subset.filter((r) => r.note?.[key] === 1).length;
  const unrated = rows.filter((r) => r.note?.recherche == null || r.note?.reponse == null);

  console.log(`Run ${runId} · ${run.config.llm.modele} · recherche ${run.config.recherche?.mode ?? "vector"} · k=${run.config.k} · commit ${run.config.commit}\n`);
  console.log(`Recherche : ${sum("recherche")}/${total}`);
  console.log(`Réponse   : ${sum("reponse")}/${total}`);
  if (unrated.length > 0) {
    console.log(`\n⚠ ${unrated.length} question(s) pas entièrement notée(s), comptée(s) comme non réussies : ${unrated.map((r) => r.id).join(", ")}`);
  }

  console.log("\nPar type              recherche   réponse");
  for (const type of QUESTION_TYPES) {
    const subset = rows.filter((r) => r.type === type);
    if (subset.length === 0) continue;
    console.log(
      `  ${type.padEnd(18)} ${`${sum("recherche", subset)}/${subset.length}`.padStart(9)} ` +
        `${`${sum("reponse", subset)}/${subset.length}`.padStart(9)}`,
    );
  }

  // Un échec se lit en croisant les deux notes : c'est ce qui dit quoi corriger.
  const failures = rows.filter((r) => r.note?.recherche === 0 || r.note?.reponse === 0);
  console.log(`\nÉchecs (${failures.length})`);
  for (const r of failures) {
    console.log(`  ${r.id} ${r.type.padEnd(12)} ${diagnose(r.note!)}${r.note?.commentaire ? ` — ${r.note.commentaire}` : ""}`);
  }
}

function diagnose({ recherche, reponse }: { recherche: 0 | 1 | null; reponse: 0 | 1 | null }): string {
  if (recherche === 0 && reponse === 0) return "erreur de RECHERCHE (le bon passage n'a pas été récupéré)";
  if (recherche === 0) return "recherche ratée mais réponse juste (autre passage, ou chance) : à surveiller";
  if (recherche === 1 && reponse === 0) return "erreur de GÉNÉRATION (le passage était là, la réponse est fausse)";
  return "notes incomplètes";
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
