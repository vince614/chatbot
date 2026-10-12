import Fastify from "fastify";

import { ConfigError, loadConfig } from "./config.js";

// Le serveur refuse de démarrer si la configuration est incomplète.
const config = loadConfigOrExit();

const app = Fastify({ logger: true });

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
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
