// npm run db:migrate — crée ou met à jour le schéma du RAG.
import { runMigrations } from "@chatbot/rag/db/migrate";
import { createPool } from "@chatbot/rag/db/pool";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";

import { ConfigError, loadDatabaseConfig } from "../../config.js";

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
