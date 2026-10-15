import { access, writeFile } from "node:fs/promises";

import type { EvalQuestion, RunFile, RunResult, Source } from "./types.js";

/**
 * Le rapport à noter à la main : pour chaque question, l'attendu et l'obtenu
 * côte à côte, et un fichier de notes pré-rempli de null. Aucune note n'est
 * calculée ici : c'est le rôle de la personne qui connaît le sujet.
 */

export interface Note {
  /** 1 si le bon passage figure dans les k chunks récupérés. */
  recherche: 0 | 1 | null;
  /** 1 si la réponse est juste et cite la bonne source (ou dit « Je ne sais pas » quand il le faut). */
  reponse: 0 | 1 | null;
  commentaire: string;
}

export type Notes = Record<string, Note>;

/** Écrit <run>.md et, s'il n'existe pas encore, <run>.notes.json (jamais écrasé). */
export async function writeReport(runPath: string, run: RunFile, questions: EvalQuestion[]): Promise<void> {
  const base = runPath.replace(/\.json$/, "");
  await writeFile(`${base}.md`, renderReport(base.split("/").at(-1)!, run, questions));

  const notesPath = `${base}.notes.json`;
  const notesExist = await access(notesPath).then(
    () => true,
    () => false,
  );
  if (!notesExist) {
    const notes: Notes = Object.fromEntries(
      run.resultats.map((r) => [r.id, { recherche: null, reponse: null, commentaire: "" }]),
    );
    await writeFile(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
  }
}

export function renderReport(runId: string, run: RunFile, questions: EvalQuestion[]): string {
  const { config } = run;
  const byId = new Map(questions.map((q) => [q.id, q]));

  const header = [
    `# Run ${runId}`,
    "",
    `Modèle ${config.llm.modele} (effort ${config.llm.effort}) · embeddings ${config.embeddings.modele} ·`,
    `chunks de ${config.decoupage.tokens_par_chunk} tokens (recouvrement ${config.decoupage.recouvrement * 100} %) ·`,
    `recherche ${config.recherche?.mode ?? "vector"} · utilisateur ${config.utilisateur?.id ?? "(avant les droits)"} · ` +
      `k = ${config.k} · commit ${config.commit}`,
    "",
    "## Comment noter",
    "",
    `Remplis \`${runId}.notes.json\` : deux notes par question, 0 ou 1.`,
    "",
    "- **recherche** : 1 si le bon passage figure dans les chunks récupérés (compare les pages).",
    "  Pour une question **sans réponse**, il n'y a rien à trouver : mets 1.",
    "- **reponse** : 1 si la réponse est juste **et** cite la bonne source.",
    "  Pour une question **sans réponse** : 1 si le modèle dit « Je ne sais pas » sans inventer.",
    "",
    `Puis : \`npm run eval:score -- ${runId}\``,
    "",
  ];

  const sections = run.resultats.map((result) => renderQuestion(result, byId.get(result.id)));
  return [...header, ...sections].join("\n");
}

export function renderQuestion(result: RunResult, question: EvalQuestion | undefined): string {
  const expectedPages = question?.avec_reponse ? formatSources(question.sources_attendues) : "— (aucune réponse dans les documents)";
  const retrieved = result.chunks_recuperes
    .map((c) => `${c.rang}. ${c.fichier} ${formatPages(c.pages)} (${c.score.toFixed(3)})`)
    .join("<br>");
  const cited =
    result.sources_citees.length > 0
      ? result.sources_citees.map((s) => `[${s.index}] ${s.fichier} ${formatPages(s.pages)}`).join("<br>")
      : "aucune";

  return [
    "---",
    "",
    `## ${result.id} · ${result.type}`,
    "",
    `> ${result.question}`,
    "",
    "| | Attendu | Obtenu |",
    "| --- | --- | --- |",
    `| **Réponse** | ${cell(question?.reponse_attendue ?? "?")} | ${cell(result.erreur ? `**ERREUR** : ${result.erreur}` : (result.reponse_obtenue ?? ""))} |`,
    `| **Pages** | ${expectedPages} | récupérées :<br>${retrieved || "aucune"}<br><br>citées :<br>${cited} |`,
    "",
    `Notes → \`${result.id}\` : recherche \`__\` · réponse \`__\` · durée ${(result.duree_ms / 1000).toFixed(1)} s`,
    "",
  ].join("\n");
}

function formatSources(sources: Source[]): string {
  return sources.map((s) => `${s.fichier} ${formatPages(s.pages)}`).join("<br>");
}

function formatPages(pages: number[]): string {
  return pages.length === 1 ? `p. ${pages[0]}` : `p. ${pages[0]}–${pages.at(-1)}`;
}

/** Une cellule de tableau Markdown ne peut contenir ni saut de ligne ni « | ». */
function cell(text: string): string {
  return text.trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
