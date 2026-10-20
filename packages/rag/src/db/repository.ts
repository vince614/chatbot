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
  /** Groupes autorisés à lire le document ([] : personne). */
  allowedGroups: string[];
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

    // Les droits sont écrits dans la même transaction que les chunks : la
    // nouvelle version n'existe jamais sans ses droits.
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO documents (file_name, sha256, allowed_groups) VALUES ($1, $2, $3) RETURNING id",
      [doc.fileName, doc.sha256, doc.allowedGroups],
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

/**
 * Applique l'ACL à TOUS les documents en base, qu'ils aient été réingérés ou
 * non : le sha256 couvre le contenu du PDF, pas ses droits. Un document absent
 * de l'ACL reçoit '{}' (personne).
 *
 * L'ACL est envoyée en un seul objet JSON ; pour chaque document,
 * $1 -> file_name donne sa liste (NULL si absent), et ARRAY(SELECT …) en fait
 * un text[] (vide si NULL). Seules les lignes qui changent sont réécrites, et
 * renvoyées pour être affichées.
 */
export async function applyAcl(
  pool: pg.Pool,
  acl: Map<string, string[]>,
): Promise<{ fileName: string; allowedGroups: string[] }[]> {
  const { rows } = await pool.query<{ file_name: string; allowed_groups: string[] }>(
    `WITH target AS (
       SELECT id, ARRAY(SELECT jsonb_array_elements_text($1::jsonb -> file_name)) AS groups
       FROM documents
     )
     UPDATE documents d
     SET allowed_groups = t.groups
     FROM target t
     WHERE d.id = t.id AND d.allowed_groups IS DISTINCT FROM t.groups
     RETURNING d.file_name, d.allowed_groups`,
    [JSON.stringify(Object.fromEntries(acl))],
  );
  return rows.map((row) => ({ fileName: row.file_name, allowedGroups: row.allowed_groups }));
}

export interface VisibleDocument {
  fileName: string;
  /** Dernière page qui contient du texte (MAX(page_end) des chunks) : la base ne stocke pas le nombre de pages du PDF. */
  pages: number;
  ingestedAt: Date;
}

/**
 * Les documents que ces groupes peuvent lire. Le filtre est dans le WHERE,
 * comme pour la recherche : un document interdit ne sort jamais de la base,
 * pas même son nom.
 */
export async function listVisibleDocuments(pool: pg.Pool, userGroups: readonly string[]): Promise<VisibleDocument[]> {
  if (userGroups.length === 0) return [];
  const { rows } = await pool.query<{ file_name: string; pages: number; ingested_at: Date }>(
    `SELECT d.file_name, COALESCE(MAX(c.page_end), 0)::int AS pages, d.ingested_at
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.allowed_groups && $1::text[]
     GROUP BY d.id
     ORDER BY d.file_name`,
    [userGroups],
  );
  return rows.map((row) => ({ fileName: row.file_name, pages: row.pages, ingestedAt: row.ingested_at }));
}

export interface DocumentPassage {
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  content: string;
}

/**
 * Les passages d'un document, dans l'ordre, si ces groupes peuvent le lire ;
 * null sinon. Un document interdit et un document inexistant donnent le même
 * résultat : l'appelant ne peut pas les distinguer.
 */
export async function readVisibleDocument(
  pool: pg.Pool,
  fileName: string,
  userGroups: readonly string[],
): Promise<DocumentPassage[] | null> {
  if (userGroups.length === 0) return null;
  const { rows } = await pool.query<{ chunk_index: number; page_start: number; page_end: number; content: string }>(
    `SELECT c.chunk_index, c.page_start, c.page_end, c.content
     FROM documents d JOIN chunks c ON c.document_id = d.id
     WHERE d.file_name = $1 AND d.allowed_groups && $2::text[]
     ORDER BY c.chunk_index`,
    [fileName, userGroups],
  );
  if (rows.length === 0) return null;
  return rows.map((row) => ({ chunkIndex: row.chunk_index, pageStart: row.page_start, pageEnd: row.page_end, content: row.content }));
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
 * Les `limit` chunks les plus proches du vecteur de la question, parmi ceux
 * que l'utilisateur a le droit de lire.
 *
 * Contrôle d'accès : `d.allowed_groups && $3` (« au moins un groupe en
 * commun ») est dans le WHERE, donc appliqué AVANT le tri et le LIMIT. Les
 * `limit` résultats sont les plus proches parmi les chunks autorisés ; un
 * chunk interdit ne sort jamais de la base.
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
WHERE d.allowed_groups && $3::text[]
ORDER BY c.embedding <=> $1::vector
LIMIT $2`;

export async function searchChunks(
  pool: pg.Pool,
  queryVector: number[],
  limit: number,
  userGroups: readonly string[],
): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchRow>(SEARCH_SQL, [toSqlVector(queryVector), limit, userGroups]);
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
 * 3. Contrôle d'accès : comme pour SEARCH_SQL, le filtre sur les groupes
 *    est dans le WHERE, avant le classement et le LIMIT.
 * 4. @@ garde les chunks qui contiennent au moins un lexème (index GIN),
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
  AND d.allowed_groups && $3::text[]
ORDER BY score DESC, c.id
LIMIT $2`;

export async function searchLexical(
  pool: pg.Pool,
  question: string,
  limit: number,
  userGroups: readonly string[],
): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchRow>(LEXICAL_SEARCH_SQL, [question, limit, userGroups]);
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
