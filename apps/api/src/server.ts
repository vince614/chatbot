import { createPool } from "@chatbot/rag/db/pool";
import { createEmbeddingClient } from "@chatbot/rag/embeddings/index";
import { createRetriever } from "@chatbot/rag/retrieve";
import { loadUsers } from "@chatbot/rag/users";
import Fastify from "fastify";

import {
  ConfigError,
  loadConfig,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  loadRagMode,
  loadSearchMode,
  USERS_FILE,
} from "./config.js";
import { createLlmClient } from "./llm/index.js";
import { createMcpPool } from "./mcp/index.js";
import { chatRoutes } from "./routes/chat.js";
import { calculateTool, getCurrentDatetimeTool } from "./tools/index.js";

// Le serveur refuse de démarrer si la configuration est incomplète.
const config = loadConfigOrExit();
// Les utilisateurs fictifs (data/users.json), lus une fois au démarrage.
const users = await exitOnConfigError(loadUsers(USERS_FILE));
const llm = createLlmClient(config.llm);
// Les outils maison, déclarés ici. Le registre, lui, est construit à chaque
// requête : il y ajoute les outils MCP de l'utilisateur qui demande.
const localTools = [getCurrentDatetimeTool, calculateTool];
// La recherche documentaire, construite une fois. Le pool n'ouvre aucune
// connexion tant qu'on ne s'en sert pas : une base arrêtée n'empêche pas le
// serveur de démarrer, elle fera échouer la recherche avec un message clair.
const pool = createPool(config.rag.databaseUrl);
const retrieve = createRetriever({
  pool,
  embedder: createEmbeddingClient(config.rag.embedding),
  defaultMode: config.rag.searchMode,
});

// Le logger par défaut trace méthode, URL et statut : jamais le corps des requêtes.
const app = Fastify({ logger: true });
// Les serveurs MCP (un sous-processus par utilisateur), démarrés au premier
// message de chacun. Rien n'est lancé ici : un serveur MCP en panne
// n'empêche pas l'API de démarrer.
const mcp = createMcpPool({ log: app.log });
// À l'arrêt du serveur, on ferme proprement les connexions à la base et les sous-processus.
app.addHook("onClose", async () => {
  const [, closed] = await Promise.all([pool.end(), mcp.close()]);
  app.log.info({ mcpServers: closed }, "serveurs MCP fermés");
});
// Ctrl+C (SIGINT) ou arrêt par le système (SIGTERM, tsx watch) : Fastify ne
// ferme rien de lui-même. Sans cela, les sous-processus s'arrêteraient quand
// même (leur stdin se ferme avec nous), mais sans attendre leur fin propre.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "arrêt demandé");
    void app.close().then(() => process.exit(0));
  });
}
// Une connexion inactive coupée par Postgres (redémarrage de la base) émet une
// erreur sur le pool : sans écouteur, Node arrêterait tout le serveur.
pool.on("error", (error) => app.log.warn({ reason: error.message }, "connexion Postgres perdue"));

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    // Pour le sélecteur d'utilisateur de l'interface (exercice : voir
    // auth/fake-identity.ts). Identifiant et nom seulement, jamais les groupes.
    api.get("/users", async () => ({ users: [...users.values()].map(({ id, nom }) => ({ id, nom })) }));
    await api.register(chatRoutes, { llm, localTools, ragMode: config.ragMode, retrieve, mcp, users });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });
app.log.info({ ragMode: config.ragMode }, "mode de recherche documentaire");

async function exitOnConfigError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function loadConfigOrExit() {
  try {
    return {
      ...loadConfig(),
      ragMode: loadRagMode(),
      rag: {
        databaseUrl: loadDatabaseConfig().databaseUrl,
        embedding: loadEmbeddingConfig(),
        searchMode: loadSearchMode(),
      },
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
