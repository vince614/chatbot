import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type pg from "pg";

/** Dossier des fichiers NNN_nom.sql, appliqués dans l'ordre alphabétique. */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Marqueurs remplacés dans le SQL avant exécution. */
interface MigrationVariables {
  EMBEDDING_DIMENSION: number;
}

/**
 * Applique les migrations pas encore passées. La table schema_migrations
 * mémorise celles déjà appliquées : relancer la commande ne fait rien de plus.
 * Chaque migration tourne dans sa propre transaction : si elle échoue, la base
 * reste dans l'état d'avant cette migration.
 *
 * Renvoie les noms des migrations appliquées pendant cet appel.
 */
export async function runMigrations(pool: pg.Pool, variables: MigrationVariables): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const sql = render(await readFile(MIGRATIONS_DIR + file, "utf8"), variables);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Échec de la migration ${file}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return applied;
}

/** Remplace chaque {{NOM}} par sa valeur ; un marqueur inconnu est une erreur. */
function render(sql: string, variables: MigrationVariables): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in variables)) throw new Error(`Variable de migration inconnue : {{${name}}}`);
    return String(variables[name as keyof MigrationVariables]);
  });
}
