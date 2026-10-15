import type { EvalQuestion, RunResult, Source } from "../types.js";

/**
 * Le verdict d'un grader sur une question : un score et la raison, lisible
 * telle quelle dans le rapport. Les graders par code ne rendent que 0 ou 1 ;
 * le juge (exactitude) peut rendre 0,5.
 */
export interface Grade {
  score: number;
  raison: string;
}

/**
 * Un grader par code : une fonction pure, sans réseau ni modèle. null quand le
 * critère ne s'applique pas à la question (ex. citation d'une question sans
 * réponse) : elle sort alors du total, au lieu d'y ajouter un point gratuit.
 */
export type CodeGrader = (question: EvalQuestion, result: RunResult) => Grade | null;

/** Un chunk récupéré ou une source citée « couvre » une source attendue : même fichier, au moins une page commune. */
export function covers(found: Source, expected: Source): boolean {
  return found.fichier === expected.fichier && found.pages.some((page) => expected.pages.includes(page));
}

/** « discordinvites p. 2–3 » : une source, pour les raisons et les rapports. */
export function formatSource({ fichier, pages }: Source): string {
  const range = pages.length === 1 ? `${pages[0]}` : `${pages[0]}–${pages.at(-1)}`;
  return `${fichier.replace(/\.pdf$/, "")} p. ${range}`;
}
