// npm run search -- "ma question" [--sql] [--explain]
// Affiche les 5 chunks les plus proches de la question, via retrieve().
import { parseArgs } from "node:util";

import { ConfigError } from "../../config.js";
import { loadDatabaseConfig, loadEmbeddingConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { SEARCH_SQL, toSqlVector } from "../db/repository.js";
import { assertEmbeddingDimension } from "../db/schema.js";
import { createEmbeddingClient } from "../embeddings/index.js";
import { createRetriever, DEFAULT_K, formatPages } from "../retrieve.js";
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

    const retrieve = createRetriever({ pool, embedder });
    const results = await retrieve(question, { k: DEFAULT_K });

    if (values.sql) console.log(`Requête SQL ($1 = vecteur de la question, $2 = ${DEFAULT_K}) :${SEARCH_SQL}\n`);

    if (results.length === 0) {
      console.log("Aucun chunk en base : lance d'abord « npm run ingest ».");
      return;
    }

    console.log(`Question : « ${question} »\n`);
    results.forEach((result, rank) => {
      const excerpt = result.content.replace(/\s+/g, " ");
      console.log(
        `#${rank + 1}  score ${result.score.toFixed(3)}  ${result.fileName}  ${formatPages(result)}  (chunk ${result.chunkIndex})`,
      );
      console.log(`    ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}\n`);
    });

    if (values.explain) {
      // Montre comment Postgres exécute la requête : sans index, un « Seq Scan »
      // qui calcule la distance pour chaque chunk, puis un tri.
      // retrieve() ne renvoie pas le vecteur de la question, et le recalculer
      // coûterait un appel Voyage. Le plan ne dépend pas des valeurs du vecteur :
      // un vecteur unitaire quelconque de la bonne dimension suffit.
      const dimension = dbConfig.embeddingDimension;
      const probe = new Array<number>(dimension).fill(1 / Math.sqrt(dimension));
      const { rows } = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE ${SEARCH_SQL}`, [
        toSqlVector(probe),
        DEFAULT_K,
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
