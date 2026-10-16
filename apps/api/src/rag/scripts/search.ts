// npm run search -- --user <id> "ma question" [--mode vector|lexical|hybrid] [--sql] [--explain]
// Affiche les 5 chunks les mieux classés pour la question, parmi ceux que
// l'utilisateur a le droit de lire, via retrieve().
import { parseArgs } from "node:util";

import { createPool } from "@chatbot/rag/db/pool";
import { LEXICAL_SEARCH_SQL, SEARCH_SQL, toSqlVector } from "@chatbot/rag/db/repository";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";
import { createEmbeddingClient } from "@chatbot/rag/embeddings/index";
import {
  createRetriever,
  DEFAULT_K,
  formatPages,
  HYBRID_CANDIDATES,
  RRF_K,
  SEARCH_MODES,
  type SearchMode,
  type SearchRanks,
} from "@chatbot/rag/retrieve";
import { requireUser } from "@chatbot/rag/users";

import { ConfigError, loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode, USERS_FILE } from "../../config.js";

const EXCERPT_CHARS = 300;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      // Sans --mode : celui de RAG_SEARCH_MODE, comme /chat.
      user: { type: "string" },
      mode: { type: "string" },
      sql: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
    },
  });

  const question = positionals.join(" ").trim();
  const mode = (values.mode ?? loadSearchMode()) as SearchMode;
  if (question === "" || !SEARCH_MODES.includes(mode)) {
    console.error(
      `Usage : npm run search -- --user <id> "ma question" [--mode ${SEARCH_MODES.join("|")}] [--sql] [--explain]`,
    );
    process.exitCode = 1;
    return;
  }

  const user = await requireUser(USERS_FILE, values.user);
  const dbConfig = loadDatabaseConfig();
  const embedder = createEmbeddingClient(loadEmbeddingConfig());
  const pool = createPool(dbConfig.databaseUrl);

  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);

    const retrieve = createRetriever({ pool, embedder });
    const results = await retrieve(question, { userGroups: user.groupes, k: DEFAULT_K, mode });

    if (values.sql) {
      // En hybride, chaque requête demande HYBRID_CANDIDATES chunks, puis la fusion se fait en TypeScript.
      const limit = mode === "hybrid" ? HYBRID_CANDIDATES : DEFAULT_K;
      if (mode !== "lexical") console.log(`Requête vectorielle ($1 = vecteur de la question, $2 = ${limit}, $3 = groupes de ${user.id}) :${SEARCH_SQL}\n`);
      if (mode !== "vector") console.log(`Requête plein texte ($1 = texte de la question, $2 = ${limit}, $3 = groupes de ${user.id}) :${LEXICAL_SEARCH_SQL}\n`);
    }

    if (results.length === 0) {
      console.log(
        mode === "lexical"
          ? `Aucun chunk autorisé pour ${user.id} ne contient un mot de la question (après normalisation).`
          : `Aucun chunk autorisé pour ${user.id} (documents absents, ou aucun groupe en commun).`,
      );
      return;
    }

    console.log(`Question : « ${question} » · mode ${mode} · utilisateur ${user.id}\n`);
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
        user.groupes,
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
        user.groupes,
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
