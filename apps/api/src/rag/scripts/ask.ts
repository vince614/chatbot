// npm run ask -- --user <id> "ma question" [--k 5]
// Pose une question aux documents, hors du serveur : affiche le prompt
// assemblé, la réponse du modèle en flux, puis les sources citées.
import { parseArgs } from "node:util";

import { requireUser } from "../../auth/users.js";
import { ConfigError, loadConfig } from "../../config.js";
import { createLlmClient } from "../../llm/index.js";
import { loadDatabaseConfig, loadEmbeddingConfig, loadSearchMode } from "../config.js";
import { createPool } from "../db/pool.js";
import { assertEmbeddingDimension } from "../db/schema.js";
import { createEmbeddingClient } from "../embeddings/index.js";
import { buildRagPrompt, extractCitations } from "../prompt.js";
import { createRetriever, DEFAULT_K, formatPages } from "../retrieve.js";

const RULE = "━".repeat(72);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { user: { type: "string" }, k: { type: "string", default: String(DEFAULT_K) } },
  });

  const question = positionals.join(" ").trim();
  if (question === "") {
    console.error('Usage : npm run ask -- --user <id> "ma question" [--k 5]');
    process.exitCode = 1;
    return;
  }

  const user = await requireUser(values.user);
  const llm = createLlmClient(loadConfig().llm);
  const dbConfig = loadDatabaseConfig();
  const pool = createPool(dbConfig.databaseUrl);

  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);
    const retrieve = createRetriever({
      pool,
      embedder: createEmbeddingClient(loadEmbeddingConfig()),
      defaultMode: loadSearchMode(),
    });

    // 1. Recherche, 2. prompt.
    const chunks = await retrieve(question, { userGroups: user.groupes, k: Number(values.k) });
    const prompt = buildRagPrompt(question, chunks);

    console.log(`${RULE}\nPROMPT SYSTÈME\n${RULE}\n${prompt.system}\n`);
    console.log(`${RULE}\nMESSAGE UTILISATEUR\n${RULE}\n${prompt.user}\n`);

    // 3. Réponse, affichée au fil de l'eau. Pas d'outils ici : seul le RAG est testé.
    console.log(`${RULE}\nRÉPONSE\n${RULE}`);
    let answer = "";
    for await (const event of llm.streamChat({
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    })) {
      if (event.type === "text") {
        answer += event.text;
        process.stdout.write(event.text);
      }
    }

    // 4. Sources : celles que la réponse cite, puis celles récupérées mais non citées.
    const cited = extractCitations(answer, chunks.length);
    console.log(`\n\n${RULE}\nSOURCES CITÉES\n${RULE}`);
    if (cited.length === 0) console.log("(aucune)");
    for (const index of cited) {
      const chunk = chunks[index - 1]!;
      console.log(`[${index}] ${chunk.fileName}, ${formatPages(chunk)} — score ${chunk.score.toFixed(3)}`);
    }
    const unused = chunks.map((_, i) => i + 1).filter((index) => !cited.includes(index));
    if (unused.length > 0) console.log(`\nRécupérées mais non citées : ${unused.map((i) => `[${i}]`).join(" ")}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
