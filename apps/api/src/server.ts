import Fastify from "fastify";

import { ConfigError, loadConfig } from "./config.js";
import { createLlmClient } from "./llm/index.js";
import { chatRoutes } from "./routes/chat.js";

// Le serveur refuse de démarrer si la configuration est incomplète.
const config = loadConfigOrExit();
const llm = createLlmClient(config.llm);

// Le logger par défaut trace méthode, URL et statut : jamais le corps des requêtes.
const app = Fastify({ logger: true });

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    await api.register(chatRoutes, { llm });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
