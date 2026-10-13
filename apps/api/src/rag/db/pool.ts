import pg from "pg";

/**
 * Crée un pool de connexions Postgres. Un pool garde quelques connexions
 * ouvertes et les prête à la demande : pool.query() pour une requête isolée,
 * pool.connect() quand plusieurs requêtes doivent partager une transaction.
 * Penser à appeler pool.end() en fin de script, sinon Node ne s'arrête pas.
 */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}
