// npm run db:migrate — crée ou met à jour le schéma du RAG.
import { ConfigError } from "../../config.js";
import { loadDatabaseConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { assertEmbeddingDimension } from "../db/schema.js";

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const pool = createPool(config.databaseUrl);

  try {
    const applied = await runMigrations(pool, { EMBEDDING_DIMENSION: config.embeddingDimension });
    if (applied.length === 0) {
      console.log("Schéma déjà à jour, aucune migration appliquée.");
    } else {
      for (const name of applied) console.log(`Migration appliquée : ${name}`);
    }
    await assertEmbeddingDimension(pool, config.embeddingDimension);
    console.log(`Colonne chunks.embedding : vector(${config.embeddingDimension}) ✔`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
