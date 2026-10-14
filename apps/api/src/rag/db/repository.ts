import type pg from "pg";

import type { Chunk } from "../text/types.js";

/**
 * Toutes les requêtes SQL du RAG. Les scripts orchestrent, ce fichier parle
 * à la base.
 */

/** pgvector lit un vecteur sous forme de texte : '[0.12,-0.03,…]'. */
export function toSqlVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Empreinte de chaque document déjà ingéré, par nom de fichier. */
export async function getDocumentHashes(pool: pg.Pool): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ file_name: string; sha256: string }>(
    "SELECT file_name, sha256 FROM documents",
  );
  return new Map(rows.map((row) => [row.file_name, row.sha256]));
}

/** Les documents en base, avec leur empreinte et leur nombre de chunks. */
export async function listDocuments(
  pool: pg.Pool,
): Promise<{ fileName: string; sha256: string; chunks: number }[]> {
  const { rows } = await pool.query<{ file_name: string; sha256: string; chunks: string }>(`
    SELECT d.file_name, d.sha256, count(c.id) AS chunks
    FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id ORDER BY d.file_name`);
  return rows.map((row) => ({ fileName: row.file_name, sha256: row.sha256, chunks: Number(row.chunks) }));
}

export interface DocumentToStore {
  fileName: string;
  sha256: string;
  chunks: Chunk[];
  /** Un vecteur par chunk, dans le même ordre. */
  embeddings: number[][];
}

/**
 * Remplace un document et tous ses chunks, en une seule transaction :
 * soit tout est écrit, soit rien ne change. Une recherche lancée pendant
 * l'ingestion voit l'ancienne version complète, jamais un mélange.
 *
 * Les embeddings sont déjà calculés : la transaction ne contient que des
 * écritures rapides, aucun appel réseau vers le fournisseur.
 */
export async function replaceDocument(pool: pg.Pool, doc: DocumentToStore): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Les anciens chunks partent avec le document (ON DELETE CASCADE).
    await client.query("DELETE FROM documents WHERE file_name = $1", [doc.fileName]);

    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO documents (file_name, sha256) VALUES ($1, $2) RETURNING id",
      [doc.fileName, doc.sha256],
    );
    const documentId = rows[0]!.id;

    // Une seule requête pour tous les chunks : chaque colonne est envoyée
    // comme un tableau, et unnest() les « dézippe » en lignes.
    await client.query(
      `INSERT INTO chunks (document_id, chunk_index, page_start, page_end, content, token_count, embedding)
       SELECT $1, t.chunk_index, t.page_start, t.page_end, t.content, t.token_count, t.embedding::vector
       FROM unnest($2::int[], $3::int[], $4::int[], $5::text[], $6::int[], $7::text[])
         AS t(chunk_index, page_start, page_end, content, token_count, embedding)`,
      [
        documentId,
        doc.chunks.map((c) => c.index),
        doc.chunks.map((c) => c.pageStart),
        doc.chunks.map((c) => c.pageEnd),
        doc.chunks.map((c) => c.content),
        doc.chunks.map((c) => c.tokenCount),
        doc.embeddings.map(toSqlVector),
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SearchResult {
  fileName: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  content: string;
  /**
   * Dépend de la recherche : similarité cosinus en vectoriel (1 = même
   * direction, 0 = sans rapport), ts_rank en plein texte (sans borne fixe,
   * comparable seulement entre résultats d'une même question).
   */
  score: number;
}

/**
 * Les `limit` chunks les plus proches du vecteur de la question.
 *
 * <=> est l'opérateur « distance cosinus » de pgvector (1 − similarité) :
 * on trie par distance croissante et on affiche 1 − distance comme score.
 * Le ORDER BY porte sur l'expression brute (et non sur l'alias score) pour
 * qu'un futur index HNSW en vector_cosine_ops puisse être utilisé.
 */
export const SEARCH_SQL = `
SELECT d.file_name,
       c.chunk_index,
       c.page_start,
       c.page_end,
       c.content,
       1 - (c.embedding <=> $1::vector) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
ORDER BY c.embedding <=> $1::vector
LIMIT $2`;

export async function searchChunks(pool: pg.Pool, queryVector: number[], limit: number): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchRow>(SEARCH_SQL, [toSqlVector(queryVector), limit]);
  return rows.map(toSearchResult);
}

/**
 * Les `limit` chunks les mieux classés par la recherche plein texte.
 *
 * 1. to_tsvector('french', $1) normalise la question comme les chunks l'ont
 *    été (mots vides retirés, mots réduits à leur racine).
 * 2. Ses lexèmes sont reliés par « | » (OU). plainto_tsquery les relierait par
 *    « & » (ET) : une question en langage naturel, avec ses mots en trop,
 *    n'aurait presque jamais de chunk contenant tous ses mots.
 *    quote_literal protège les lexèmes qui contiennent un point (next.js) ;
 *    le cast ::tsquery ne re-racinise pas des mots déjà racinisés.
 * 3. @@ garde les chunks qui contiennent au moins un lexème (index GIN),
 *    ts_rank les classe : plus il y a d'occurrences des termes, plus le score
 *    est haut. Une question faite uniquement de mots vides donne une requête
 *    NULL, donc aucun résultat.
 */
export const LEXICAL_SEARCH_SQL = `
WITH q AS (
  SELECT array_to_string(array_agg(quote_literal(lexeme)), ' | ')::tsquery AS query
  FROM unnest(to_tsvector('french', $1))
)
SELECT d.file_name,
       c.chunk_index,
       c.page_start,
       c.page_end,
       c.content,
       ts_rank(c.content_tsv, q.query) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
CROSS JOIN q
WHERE c.content_tsv @@ q.query
ORDER BY score DESC, c.id
LIMIT $2`;

export async function searchLexical(pool: pg.Pool, question: string, limit: number): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchRow>(LEXICAL_SEARCH_SQL, [question, limit]);
  return rows.map(toSearchResult);
}

interface SearchRow {
  file_name: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
  score: number;
}

function toSearchResult(row: SearchRow): SearchResult {
  return {
    fileName: row.file_name,
    chunkIndex: row.chunk_index,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    content: row.content,
    score: Number(row.score),
  };
}
