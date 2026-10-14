import { fileURLToPath } from "node:url";

import { z } from "zod";

/** apps/api/evals/ : les questions (versionnées) et les runs (ignorés par git). */
export const EVALS_DIR = fileURLToPath(new URL("../../evals/", import.meta.url));
export const QUESTIONS_FILE = `${EVALS_DIR}questions.json`;
export const RUNS_DIR = `${EVALS_DIR}runs/`;

export const QUESTION_TYPES = [
  "factuelle",
  "reformulee",
  "identifiant",
  "tableau",
  "combinaison",
  "sans_reponse",
] as const;

/** Une source attendue ou obtenue : un fichier et des numéros de page. */
const sourceSchema = z.object({ fichier: z.string(), pages: z.array(z.number().int().positive()) });
export type Source = z.infer<typeof sourceSchema>;

export const questionSchema = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  question: z.string().min(1),
  reponse_attendue: z.string().min(1),
  sources_attendues: z.array(sourceSchema),
  avec_reponse: z.boolean(),
});
export type EvalQuestion = z.infer<typeof questionSchema>;

/** Tout ce qui peut faire varier les résultats : deux runs ne se comparent que si ceci est identique. */
export interface RunConfig {
  date: string;
  llm: { fournisseur: string; modele: string; effort: string; temperature: null };
  embeddings: { fournisseur: string; modele: string; dimension: number };
  decoupage: { tokens_par_chunk: number; recouvrement: number };
  k: number;
  /**
   * Recherche utilisée. Absente dans les runs antérieurs à la recherche
   * hybride : ils ont tous été faits en vectoriel.
   */
  recherche?: { mode: string; candidats_par_recherche?: number; rrf_k?: number };
  /** Commit Git du code, avec « -modifie » si des fichiers n'étaient pas commités. */
  commit: string;
  /** Empreintes : un prompt ou des questions modifiés rendent deux runs incomparables. */
  sha256_prompt_systeme: string;
  sha256_questions: string;
  documents: { fichier: string; sha256: string; chunks: number }[];
}

export interface RunResult {
  id: string;
  type: EvalQuestion["type"];
  question: string;
  reponse_obtenue: string | null;
  /** Les extraits que la réponse cite ([1], [3]…), dans l'ordre de citation. */
  sources_citees: (Source & { index: number })[];
  /** Les k chunks récupérés, dans l'ordre du classement. */
  chunks_recuperes: (Source & { rang: number; score: number })[];
  duree_ms: number;
  erreur: string | null;
}

export interface RunFile {
  config: RunConfig;
  resultats: RunResult[];
}

/** « 2026-10-13T15-42-07 » : date-heure locale, sans « : » (interdit dans certains noms de fichiers). */
export function runIdFromDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Pages couvertes par un chunk : [2, 3] pour « p. 2–3 ». */
export function pageRange(pageStart: number, pageEnd: number): number[] {
  return Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i);
}
