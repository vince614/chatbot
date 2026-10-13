// npm run search -- "ma question" [--sql] [--explain]
// Affiche les 5 chunks les plus proches de la question.
import { parseArgs } from "node:util";

import { ConfigError } from "../../config.js";
import { loadDatabaseConfig, loadEmbeddingConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { SEARCH_SQL, searchChunks, toSqlVector } from "../db/repository.js";
import { assertEmbeddingDimension } from "../db/schema.js";
import { createEmbeddingClient } from "../embeddings/index.js";

const TOP_K = 5;
const EXCERPT_CHARS = 300;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      sql: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
    },
  });

  const question = positionals.join(" ").trim();
  if (question === "") {
    console.error('Usage : npm run search -- "ma question" [--sql] [--explain]');
    process.exitCode = 1;
    return;
  }

  const dbConfig = loadDatabaseConfig();
  const embedder = createEmbeddingClient(loadEmbeddingConfig());
  const pool = createPool(dbConfig.databaseUrl);

  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);

    const queryVector = await embedder.embedQuery(question);
    const results = await searchChunks(pool, queryVector, TOP_K);

    if (values.sql) console.log(`Requête SQL ($1 = vecteur de la question, $2 = ${TOP_K}) :${SEARCH_SQL}\n`);

    if (results.length === 0) {
      console.log("Aucun chunk en base : lance d'abord « npm run ingest ».");
      return;
    }

    console.log(`Question : « ${question} »\n`);
    results.forEach((result, rank) => {
      const pages =
        result.pageStart === result.pageEnd ? `p. ${result.pageStart}` : `p. ${result.pageStart}–${result.pageEnd}`;
      const excerpt = result.content.replace(/\s+/g, " ");
      console.log(`#${rank + 1}  score ${result.score.toFixed(3)}  ${result.fileName}  ${pages}  (chunk ${result.chunkIndex})`);
      console.log(`    ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}\n`);
    });

    if (values.explain) {
      // Montre comment Postgres exécute la requête : sans index, un « Seq Scan »
      // qui calcule la distance pour chaque chunk, puis un tri.
      const { rows } = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE ${SEARCH_SQL}`, [
        toSqlVector(queryVector),
        TOP_K,
      ]);
      console.log("Plan d'exécution :");
      // Le plan recopie le vecteur littéral (1024 nombres) : on l'abrège.
      for (const row of rows) console.log(`  ${row["QUERY PLAN"].replace(/'\[[^\]]*\]'/g, "'[…]'")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
