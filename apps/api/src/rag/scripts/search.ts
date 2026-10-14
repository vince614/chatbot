// npm run search -- "ma question" [--mode vector|lexical|hybrid] [--sql] [--explain]
// Affiche les 5 chunks les mieux classés pour la question, via retrieve().
import { parseArgs } from "node:util";

import { ConfigError } from "../../config.js";
import { loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode } from "../config.js";
import { createPool } from "../db/pool.js";
import { LEXICAL_SEARCH_SQL, SEARCH_SQL, toSqlVector } from "../db/repository.js";
import { assertEmbeddingDimension } from "../db/schema.js";
import { createEmbeddingClient } from "../embeddings/index.js";
import {
  createRetriever,
  DEFAULT_K,
  formatPages,
  HYBRID_CANDIDATES,
  RRF_K,
  SEARCH_MODES,
  type SearchMode,
  type SearchRanks,
} from "../retrieve.js";

const EXCERPT_CHARS = 300;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      // Sans --mode : celui de RAG_SEARCH_MODE, comme /chat.
      mode: { type: "string" },
      sql: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
    },
  });

  const question = positionals.join(" ").trim();
  const mode = (values.mode ?? loadSearchMode()) as SearchMode;
  if (question === "" || !SEARCH_MODES.includes(mode)) {
    console.error(`Usage : npm run search -- "ma question" [--mode ${SEARCH_MODES.join("|")}] [--sql] [--explain]`);
    process.exitCode = 1;
    return;
  }

  const dbConfig = loadDatabaseConfig();
  const embedder = createEmbeddingClient(loadEmbeddingConfig());
  const pool = createPool(dbConfig.databaseUrl);

  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);

    const retrieve = createRetriever({ pool, embedder });
    const results = await retrieve(question, { k: DEFAULT_K, mode });

    if (values.sql) {
      // En hybride, chaque requête demande HYBRID_CANDIDATES chunks, puis la fusion se fait en TypeScript.
      const limit = mode === "hybrid" ? HYBRID_CANDIDATES : DEFAULT_K;
      if (mode !== "lexical") console.log(`Requête vectorielle ($1 = vecteur de la question, $2 = ${limit}) :${SEARCH_SQL}\n`);
      if (mode !== "vector") console.log(`Requête plein texte ($1 = texte de la question, $2 = ${limit}) :${LEXICAL_SEARCH_SQL}\n`);
    }

    if (results.length === 0) {
      console.log(
        mode === "lexical"
          ? "Aucun chunk ne contient un mot de la question (après normalisation)."
          : "Aucun chunk en base : lance d'abord « npm run ingest ».",
      );
      return;
    }

    console.log(`Question : « ${question} » · mode ${mode}\n`);
    if (mode === "hybrid") {
      console.log(`Fusion RRF : score = Σ 1 / (${RRF_K} + rang), sur ${HYBRID_CANDIDATES} candidats par recherche.\n`);
    }
    results.forEach((result, rank) => {
      const excerpt = result.content.replace(/\s+/g, " ");
      // En hybride : d'où vient le passage, puis son score fusionné (4 décimales, les écarts sont petits).
      const score = result.ranks
        ? `${formatRanks(result.ranks)}  RRF ${result.score.toFixed(4)}`
        : `score ${result.score.toFixed(3)}`;
      console.log(`#${rank + 1}  ${score}  ${result.fileName}  ${formatPages(result)}  (chunk ${result.chunkIndex})`);
      console.log(`    ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}\n`);
    });

    if (values.explain && mode !== "vector") {
      // Le texte de la question suffit : pas de vecteur à fabriquer.
      const { rows } = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE ${LEXICAL_SEARCH_SQL}`, [
        question,
        DEFAULT_K,
      ]);
      console.log("Plan d'exécution (plein texte) :");
      for (const row of rows) console.log(`  ${row["QUERY PLAN"]}`);
    }
    if (values.explain && mode !== "lexical") {
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
      console.log("Plan d'exécution (vectoriel) :");
      // Le plan recopie le vecteur littéral (1024 nombres) : on l'abrège.
      for (const row of rows) console.log(`  ${row["QUERY PLAN"].replace(/'\[[^\]]*\]'/g, "'[…]'")}`);
    }
  } finally {
    await pool.end();
  }
}

/** « vecteur #2 · plein texte — » : le rang dans chaque recherche, « — » si absent. */
function formatRanks({ vector, lexical }: SearchRanks): string {
  const rank = (value: number | null) => (value === null ? "—" : `#${value}`).padEnd(3);
  return `vecteur ${rank(vector)} · plein texte ${rank(lexical)}`;
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
