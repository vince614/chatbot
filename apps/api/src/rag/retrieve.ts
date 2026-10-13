import type pg from "pg";

import { searchChunks, type SearchResult } from "./db/repository.js";
import type { EmbeddingClient } from "./embeddings/index.js";

/**
 * La recherche du RAG : une question → les k passages les plus proches.
 *
 * Elle ne connaît ni Fastify, ni la route /chat, ni les variables
 * d'environnement : ses dépendances (base, client d'embeddings) lui sont
 * données une fois pour toutes par createRetriever. Le script `search`, la
 * route /chat et, plus tard, un outil ou une recherche hybride appellent tous
 * la même fonction.
 */

/** Un passage retrouvé, avec de quoi le citer. */
export type RetrievedChunk = SearchResult;

export interface RetrieveOptions {
  /** Nombre de passages à renvoyer (5 par défaut). */
  k?: number;
  /** Annule le calcul de l'embedding (déconnexion, délai dépassé). */
  signal?: AbortSignal;
}

export type Retrieve = (question: string, options?: RetrieveOptions) => Promise<RetrievedChunk[]>;

export interface RetrieverDeps {
  pool: pg.Pool;
  embedder: EmbeddingClient;
}

export const DEFAULT_K = 5;
const MAX_K = 50;

export function createRetriever({ pool, embedder }: RetrieverDeps): Retrieve {
  return async (question, { k = DEFAULT_K, signal } = {}) => {
    const text = question.trim();
    if (text === "") throw new Error("La question est vide.");
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new Error(`k doit être un entier entre 1 et ${MAX_K} (reçu : ${k}).`);
    }

    // 1. La question devient un vecteur, encodé comme une requête (input_type: "query").
    const queryVector = await embedder.embedQuery(text, { signal });
    // 2. Les k chunks les plus proches, triés par distance cosinus croissante.
    return searchChunks(pool, queryVector, k);
  };
}

/** « p. 3 » ou « p. 3–4 » : la forme sous laquelle on cite les pages d'un passage. */
export function formatPages({ pageStart, pageEnd }: Pick<RetrievedChunk, "pageStart" | "pageEnd">): string {
  return pageStart === pageEnd ? `p. ${pageStart}` : `p. ${pageStart}–${pageEnd}`;
}
