import Fastify from "fastify";

import { ConfigError, loadConfig } from "./config.js";
import { createLlmClient } from "./llm/index.js";
import { loadDatabaseConfig, loadEmbeddingConfig } from "./rag/config.js";
import { createPool } from "./rag/db/pool.js";
import { createEmbeddingClient } from "./rag/embeddings/index.js";
import { createRetriever } from "./rag/retrieve.js";
import { chatRoutes } from "./routes/chat.js";
import { calculateTool, createToolRegistry, getCurrentDatetimeTool } from "./tools/index.js";

// Le serveur refuse de démarrer si la configuration est incomplète.
const config = loadConfigOrExit();
const llm = createLlmClient(config.llm);
// Les outils sont déclarés ici, au démarrage : la route ne connaît que le registre.
const tools = createToolRegistry([getCurrentDatetimeTool, calculateTool]);
// La recherche documentaire, construite une fois. Le pool n'ouvre aucune
// connexion tant qu'on ne s'en sert pas : une base arrêtée n'empêche pas le
// serveur de démarrer, elle fera échouer la recherche avec un message clair.
const pool = createPool(config.rag.databaseUrl);
const retrieve = createRetriever({ pool, embedder: createEmbeddingClient(config.rag.embedding) });

// Le logger par défaut trace méthode, URL et statut : jamais le corps des requêtes.
const app = Fastify({ logger: true });
// À l'arrêt du serveur, on ferme proprement les connexions à la base.
app.addHook("onClose", async () => pool.end());
// Une connexion inactive coupée par Postgres (redémarrage de la base) émet une
// erreur sur le pool : sans écouteur, Node arrêterait tout le serveur.
pool.on("error", (error) => app.log.warn({ reason: error.message }, "connexion Postgres perdue"));

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    await api.register(chatRoutes, { llm, tools, retrieve });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });

function loadConfigOrExit() {
  try {
    return {
      ...loadConfig(),
      rag: { databaseUrl: loadDatabaseConfig().databaseUrl, embedding: loadEmbeddingConfig() },
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
