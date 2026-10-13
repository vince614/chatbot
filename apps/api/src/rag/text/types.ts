/** Le texte d'une page de PDF. */
export interface Page {
  /** Numéro de page, à partir de 1. */
  pageNumber: number;
  /**
   * Texte brut après extraction : une ligne par ligne du PDF. Après nettoyage :
   * des paragraphes séparés par une ligne vide ("\n\n").
   */
  text: string;
}

/** Un morceau de document, prêt à être vectorisé. */
export interface Chunk {
  /** Position dans le document (0, 1, 2…). */
  index: number;
  pageStart: number;
  pageEnd: number;
  content: string;
  tokenCount: number;
}

/** Compte les tokens d'un texte. Injecté dans le découpage pour qu'il reste pur. */
export type TokenCounter = (text: string) => number;
