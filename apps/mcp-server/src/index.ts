// npm run mcp — le RAG exposé comme serveur MCP, en transport stdio.
// Lancé par un client MCP (Inspector, Claude Code), pas à la main : il lit
// ses requêtes sur stdin et répond sur stdout. MCP_USER_ID est obligatoire.
import { createPool } from "@chatbot/rag/db/pool";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";
import { createEmbeddingClient } from "@chatbot/rag/embeddings/index";
import { ConfigError } from "@chatbot/rag/env";
import { createRetriever } from "@chatbot/rag/retrieve";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadMcpConfig, type McpConfig } from "./config.js";
import { log, redirectConsoleToStderr } from "./log.js";
import { registerListDocuments } from "./tools/list-documents.js";
import { registerSearchDocuments } from "./tools/search-documents.js";

redirectConsoleToStderr();

// 1. Configuration et identité : en cas d'échec, on s'arrête avant d'ouvrir
//    le transport. Le client voit un processus terminé et le message sur stderr.
const config = await loadConfigOrExit();
const { user } = config;

// 2. La base, vérifiée dès maintenant : mieux vaut un démarrage qui échoue
//    qu'un outil qui échoue à chaque appel.
const pool = createPool(config.database.databaseUrl);
pool.on("error", (error) => log(`connexion Postgres perdue : ${error.message}`));
await exitOnError(assertEmbeddingDimension(pool, config.database.embeddingDimension));
const retrieve = createRetriever({
  pool,
  embedder: createEmbeddingClient(config.embedding),
  defaultMode: config.searchMode,
});

// 3. Le serveur MCP et ses outils. L'utilisateur est dans le contexte des
//    outils, pas dans leurs arguments : le modèle ne peut pas le changer.
const server = new McpServer({ name: "chatbot-rag", version: "0.1.0" });
const context = { user, pool, retrieve };
registerSearchDocuments(server, context);
registerListDocuments(server, context);

// 4. Le transport stdio : à partir d'ici, stdout appartient au protocole.
await server.connect(new StdioServerTransport());
// L'identifiant seulement : les groupes n'ont rien à faire dans les logs.
log(`prêt (utilisateur ${user.id}, recherche ${config.searchMode})`);

// Le client ferme stdin quand il arrête le serveur ; Ctrl+C envoie SIGINT.
const shutdown = async (): Promise<void> => {
  await server.close();
  await pool.end();
  process.exit(0);
};
process.stdin.on("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function loadConfigOrExit(): Promise<McpConfig> {
  return exitOnError(loadMcpConfig());
}

/** Une ConfigError s'affiche telle quelle ; toute autre erreur aussi, sans pile. Puis exit 1. */
async function exitOnError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    log(error instanceof ConfigError ? error.message : `démarrage impossible : ${describe(error)}`);
    process.exit(1);
  }
}

/**
 * Le message d'une erreur, jamais vide. Une base injoignable donne une
 * AggregateError sans message (Node essaie IPv4 et IPv6) : on prend alors
 * celui de la première tentative.
 */
function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors[0] instanceof Error) return error.errors[0].message;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
