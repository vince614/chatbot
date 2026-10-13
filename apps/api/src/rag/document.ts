import { extractPages } from "./pdf/extract.js";
import { chunkPages } from "./text/chunk.js";
import { cleanPages } from "./text/clean.js";
import { countTokens } from "./text/tokens.js";
import type { Chunk } from "./text/types.js";

/** Taille visée d'un chunk et recouvrement entre deux chunks consécutifs. */
export const CHUNK_TARGET_TOKENS = 500;
export const CHUNK_OVERLAP_RATIO = 0.15;

export interface SplitDocument {
  pageCount: number;
  chunks: Chunk[];
  /** En-têtes et pieds de page détectés et supprimés (un exemple de chacun). */
  removedMarginLines: string[];
}

/** PDF → pages → texte nettoyé → chunks. Aucune écriture, ni disque ni base. */
export async function splitPdf(pdfBytes: Uint8Array): Promise<SplitDocument> {
  const rawPages = await extractPages(pdfBytes);
  const { pages, removedMarginLines } = cleanPages(rawPages);
  const chunks = chunkPages(pages, {
    countTokens,
    targetTokens: CHUNK_TARGET_TOKENS,
    overlapRatio: CHUNK_OVERLAP_RATIO,
  });
  return { pageCount: rawPages.length, chunks, removedMarginLines };
}
