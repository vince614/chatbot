import type pg from "pg";

import { searchChunks, searchLexical, type SearchResult } from "./db/repository.js";
import type { EmbeddingClient } from "./embeddings/index.js";

/**
 * La recherche du RAG : une question → les k passages les mieux classés.
 *
 * Elle ne connaît ni Fastify, ni la route /chat, ni les variables
 * d'environnement : ses dépendances (base, client d'embeddings, mode par
 * défaut) lui sont données une fois pour toutes par createRetriever. Le script
 * `search`, la route /chat et l'évaluation appellent tous la même fonction.
 */

/**
 * vector  : proximité de sens (embeddings), robuste aux reformulations ;
 * lexical : mots en commun (plein texte Postgres), robuste aux termes exacts ;
 * hybrid  : les deux, fusionnés par Reciprocal Rank Fusion.
 */
export const SEARCH_MODES = ["vector", "lexical", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Rang (à partir de 1) obtenu dans chaque recherche ; null si le chunk n'y figurait pas. */
export interface SearchRanks {
  vector: number | null;
  lexical: number | null;
}

/**
 * Un passage retrouvé, avec de quoi le citer. En mode hybrid, score est le
 * score RRF et ranks dit d'où vient le passage.
 */
export type RetrievedChunk = SearchResult & { ranks?: SearchRanks };

export interface RetrieveOptions {
  /** Nombre de passages à renvoyer (5 par défaut). */
  k?: number;
  /** Recherche à utiliser (par défaut : celle donnée à createRetriever). */
  mode?: SearchMode;
  /** Annule le calcul de l'embedding (déconnexion, délai dépassé). */
  signal?: AbortSignal;
}

export type Retrieve = (question: string, options?: RetrieveOptions) => Promise<RetrievedChunk[]>;

export interface RetrieverDeps {
  pool: pg.Pool;
  embedder: EmbeddingClient;
  /** Mode utilisé quand l'appel n'en précise pas (RAG_SEARCH_MODE). */
  defaultMode?: SearchMode;
}

export const DEFAULT_K = 5;
const MAX_K = 50;

/** Candidats demandés à chaque recherche avant la fusion. */
export const HYBRID_CANDIDATES = 20;
/** Constante de lissage de RRF : la valeur du papier d'origine (Cormack et al., 2009). */
export const RRF_K = 60;

export function createRetriever({ pool, embedder, defaultMode = "vector" }: RetrieverDeps): Retrieve {
  // La question devient un vecteur (input_type: "query"), puis les chunks
  // les plus proches, triés par distance cosinus croissante.
  async function searchVector(text: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const queryVector = await embedder.embedQuery(text, { signal });
    return searchChunks(pool, queryVector, limit);
  }

  return async (question, { k = DEFAULT_K, mode = defaultMode, signal } = {}) => {
    const text = question.trim();
    if (text === "") throw new Error("La question est vide.");
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new Error(`k doit être un entier entre 1 et ${MAX_K} (reçu : ${k}).`);
    }

    switch (mode) {
      case "vector":
        return searchVector(text, k, signal);
      case "lexical":
        // Aucun appel au fournisseur d'embeddings : tout se passe dans Postgres.
        return searchLexical(pool, text, k);
      case "hybrid": {
        // Les deux recherches sont indépendantes : on les lance en même temps,
        // la durée totale est celle de la plus lente (l'appel Voyage).
        const candidates = Math.max(HYBRID_CANDIDATES, k);
        const [vector, lexical] = await Promise.all([
          searchVector(text, candidates, signal),
          searchLexical(pool, text, candidates),
        ]);
        return fuseByRrf({ vector, lexical }).slice(0, k);
      }
    }
  };
}

/**
 * Reciprocal Rank Fusion : chaque recherche donne à un chunk 1 / (RRF_K + rang),
 * et on additionne. Seuls les rangs comptent, jamais les scores : une
 * similarité cosinus (≈ 0,4) et un ts_rank (≈ 0,05) ne sont pas sur la même
 * échelle. Un chunk présent dans les deux listes cumule deux contributions.
 *
 * À score égal, le tri (stable) garde l'ordre d'insertion : la liste
 * vectorielle d'abord.
 */
export function fuseByRrf(lists: Record<keyof SearchRanks, SearchResult[]>): RetrievedChunk[] {
  const fused = new Map<string, SearchResult & { ranks: SearchRanks }>();

  for (const name of ["vector", "lexical"] as const) {
    lists[name].forEach((chunk, i) => {
      const rank = i + 1;
      // Un chunk est identifié par son document et sa position dans celui-ci.
      const key = `${chunk.fileName}#${chunk.chunkIndex}`;
      const entry = fused.get(key) ?? { ...chunk, score: 0, ranks: { vector: null, lexical: null } };
      entry.ranks[name] = rank;
      entry.score += 1 / (RRF_K + rank);
      fused.set(key, entry);
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/** « p. 3 » ou « p. 3–4 » : la forme sous laquelle on cite les pages d'un passage. */
export function formatPages({ pageStart, pageEnd }: Pick<RetrievedChunk, "pageStart" | "pageEnd">): string {
  return pageStart === pageEnd ? `p. ${pageStart}` : `p. ${pageStart}–${pageEnd}`;
}
