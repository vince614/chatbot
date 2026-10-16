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
  loadSearchMode,
  USERS_FILE,
} from "./config.js";
import { createLlmClient } from "./llm/index.js";
import { chatRoutes } from "./routes/chat.js";
import { calculateTool, createToolRegistry, getCurrentDatetimeTool } from "./tools/index.js";

// Le serveur refuse de démarrer si la configuration est incomplète.
const config = loadConfigOrExit();
// Les utilisateurs fictifs (data/users.json), lus une fois au démarrage.
const users = await exitOnConfigError(loadUsers(USERS_FILE));
const llm = createLlmClient(config.llm);
// Les outils sont déclarés ici, au démarrage : la route ne connaît que le registre.
const tools = createToolRegistry([getCurrentDatetimeTool, calculateTool]);
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
// À l'arrêt du serveur, on ferme proprement les connexions à la base.
app.addHook("onClose", async () => pool.end());
// Une connexion inactive coupée par Postgres (redémarrage de la base) émet une
// erreur sur le pool : sans écouteur, Node arrêterait tout le serveur.
pool.on("error", (error) => app.log.warn({ reason: error.message }, "connexion Postgres perdue"));

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    // Pour le sélecteur d'utilisateur de l'interface (exercice : voir
    // auth/fake-identity.ts). Identifiant et nom seulement, jamais les groupes.
    api.get("/users", async () => ({ users: [...users.values()].map(({ id, nom }) => ({ id, nom })) }));
    await api.register(chatRoutes, { llm, tools, retrieve, users });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });

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
