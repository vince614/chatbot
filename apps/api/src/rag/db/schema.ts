import type pg from "pg";

import { ConfigError } from "../../config.js";

/**
 * Vérifie que la colonne chunks.embedding a la dimension attendue.
 *
 * La dimension est figée dans la colonne au moment de la migration. Si
 * EMBEDDING_DIMENSION change ensuite (nouveau modèle), les insertions
 * échoueraient au milieu d'une ingestion : on préfère s'arrêter tout de suite
 * avec un message clair.
 */
export async function assertEmbeddingDimension(pool: pg.Pool, expected: number): Promise<void> {
  // format_type rend le type tel qu'on l'a écrit, par exemple "vector(1024)".
  const { rows } = await pool.query<{ type: string }>(`
    SELECT format_type(atttypid, atttypmod) AS type
    FROM pg_attribute
    WHERE attrelid = to_regclass('chunks') AND attname = 'embedding'
  `);

  const actual = rows[0]?.type;
  if (actual === undefined) {
    throw new ConfigError("Table chunks introuvable : lance d'abord « npm run db:migrate ».");
  }
  if (actual !== `vector(${expected})`) {
    throw new ConfigError(
      [
        `La colonne chunks.embedding est de type ${actual}, mais EMBEDDING_DIMENSION=${expected}.`,
        `Changer de dimension impose de recréer le schéma (docker compose down -v, puis`,
        `npm run db:migrate) et de tout réingérer.`,
      ].join("\n"),
    );
  }
}
