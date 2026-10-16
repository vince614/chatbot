import { appendFile, writeFile } from "node:fs/promises";

import { CODE_GRADERS, type Grade } from "./graders/index.js";
import { type Judge, JUDGE_PROMPT_VERSION } from "./graders/exactitude.js";
import { EVALS_DIR, type EvalQuestion, QUESTION_TYPES, ragLabel, type RunFile, RUNS_DIR } from "./types.js";

/**
 * Toutes les notes d'un run : les graders par code, puis le juge. Écrit
 * <run>.scores.json et ajoute une ligne à evals/history.jsonl.
 */

export const CRITERIA = ["recherche", "citation", "abstention", "exactitude"] as const;
export type Criterion = (typeof CRITERIA)[number];

/** Somme des scores et nombre de questions où le critère s'applique (16 ou 20). */
export interface Total {
  score: number;
  sur: number;
}

export interface ScoresFile {
  run: string;
  juge: { modele: string; grille: string };
  questions: {
    id: string;
    type: EvalQuestion["type"];
    notes: Record<Criterion, Grade | null>;
  }[];
  totaux: Record<Criterion, Total>;
  par_type: Record<string, Record<Criterion, Total>>;
}

/** Une ligne de evals/history.jsonl : de quoi comparer les runs dans le temps, sans aucun extrait de document. */
export interface HistoryLine {
  date: string;
  run: string;
  config: {
    modele: string;
    juge: string;
    grille: string;
    embeddings: string;
    recherche: string;
    /** always ou tool ; absent des lignes antérieures au client MCP (always). */
    rag?: string;
    k: number;
    tokens_par_chunk: number;
    utilisateur: string;
    commit: string;
  };
  scores: Record<Criterion, Total>;
}

export const HISTORY_FILE = `${EVALS_DIR}history.jsonl`;

export async function scoreRun(runId: string, run: RunFile, questions: EvalQuestion[], judge: Judge): Promise<ScoresFile> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const rows: ScoresFile["questions"] = [];

  for (const result of run.resultats) {
    const question = byId.get(result.id);
    if (!question) throw new Error(`${result.id} est dans le run mais plus dans questions.json.`);

    // 1. Le code d'abord : gratuit, exact, instantané.
    const notes = {
      recherche: CODE_GRADERS.recherche(question, result),
      citation: CODE_GRADERS.citation(question, result),
      abstention: CODE_GRADERS.abstention(question, result),
      exactitude: null as Grade | null,
    };
    // 2. Le juge ensuite, seulement là où le code ne sait pas trancher. Une
    //    erreur du juge sur une question est notée, sans arrêter les autres.
    try {
      notes.exactitude = await judge.grade(question, result);
    } catch (error) {
      notes.exactitude = { score: 0, raison: `erreur du juge : ${error instanceof Error ? error.message : error}` };
    }
    rows.push({ id: result.id, type: result.type, notes });
    const exact = notes.exactitude === null ? "—" : String(notes.exactitude.score);
    console.log(`  ${result.id} ${result.type.padEnd(12)} exactitude ${exact}`);
  }

  const parType: ScoresFile["par_type"] = {};
  for (const type of QUESTION_TYPES) {
    const subset = rows.filter((r) => r.type === type);
    if (subset.length > 0) parType[type] = totals(subset);
  }

  return {
    run: runId,
    juge: { modele: judge.model, grille: JUDGE_PROMPT_VERSION },
    questions: rows,
    totaux: totals(rows),
    par_type: parType,
  };
}

/** Un critère non applicable (null) sort du total : il n'ajoute ni point ni question. */
function totals(rows: ScoresFile["questions"]): Record<Criterion, Total> {
  return Object.fromEntries(
    CRITERIA.map((criterion) => {
      const graded = rows.map((r) => r.notes[criterion]).filter((g) => g !== null);
      return [criterion, { score: graded.reduce((sum, g) => sum + g.score, 0), sur: graded.length }];
    }),
  ) as Record<Criterion, Total>;
}

export async function writeScores(scores: ScoresFile): Promise<string> {
  const file = `${RUNS_DIR}${scores.run}.scores.json`;
  await writeFile(file, `${JSON.stringify(scores, null, 2)}\n`);
  return file;
}

/** Ajoute le run à l'historique (une ligne JSON par run : on n'écrase jamais l'existant). */
export async function appendHistory(run: RunFile, scores: ScoresFile): Promise<void> {
  const { config } = run;
  const line: HistoryLine = {
    date: config.date,
    run: scores.run,
    config: {
      modele: config.llm.modele,
      juge: scores.juge.modele,
      grille: scores.juge.grille,
      embeddings: `${config.embeddings.modele} (${config.embeddings.dimension})`,
      recherche: config.recherche?.mode ?? "vector",
      rag: ragLabel(config.rag),
      k: config.k,
      tokens_par_chunk: config.decoupage.tokens_par_chunk,
      utilisateur: config.utilisateur?.id ?? "—",
      commit: config.commit,
    },
    scores: scores.totaux,
  };
  await appendFile(HISTORY_FILE, `${JSON.stringify(line)}\n`);
}

/** « 15,5/16 » : les demi-points du juge s'écrivent avec une virgule. */
export function formatTotal({ score, sur }: Total): string {
  return sur === 0 ? "—" : `${String(score).replace(".", ",")}/${sur}`;
}
