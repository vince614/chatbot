// npm run mcp [-- --transport stdio|http] — le RAG exposé comme serveur MCP.
// stdio (par défaut) : lancé par un client MCP (Inspector, Claude Code, l'API),
// qui lui parle sur stdin/stdout ; MCP_USER_ID est obligatoire.
// http : écoute sur http://127.0.0.1:MCP_HTTP_PORT/mcp (3100 par défaut) ;
// chaque requête porte un jeton JWT du serveur d'autorisation (npm run auth).
import { createPool } from "@chatbot/rag/db/pool";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";
import { createEmbeddingClient } from "@chatbot/rag/embeddings/index";
import { ConfigError } from "@chatbot/rag/env";
import { createRetriever } from "@chatbot/rag/retrieve";

import { createJwtAuthenticator } from "./auth.js";
import { loadHttpConfig, loadMcpConfig, loadStdioUser, parseTransport } from "./config.js";
import { log, redirectConsoleToStderr } from "./log.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

redirectConsoleToStderr();

// 1. Configuration : en cas d'échec, on s'arrête avant d'ouvrir le transport.
//    Le client voit un processus terminé et le message sur stderr.
const transport = await exitOnError(() => parseTransport(process.argv.slice(2)));
const config = await exitOnError(loadMcpConfig);

// 2. La base, vérifiée dès maintenant : mieux vaut un démarrage qui échoue
//    qu'un outil qui échoue à chaque appel. Base et recherche sont partagées
//    par tous les utilisateurs ; seul l'utilisateur change d'un contexte à l'autre.
const pool = createPool(config.database.databaseUrl);
pool.on("error", (error) => log(`connexion Postgres perdue : ${error.message}`));
await exitOnError(() => assertEmbeddingDimension(pool, config.database.embeddingDimension));
const retrieve = createRetriever({
  pool,
  embedder: createEmbeddingClient(config.embedding),
  defaultMode: config.searchMode,
});

// 3. Le transport. Les outils sont les mêmes dans les deux cas (server.ts) :
//    seule change la façon dont les messages arrivent, et d'où vient l'utilisateur.
let stop: () => Promise<void>;
if (transport === "stdio") {
  const user = await exitOnError(loadStdioUser);
  stop = await startStdio({ user, pool, retrieve }, config.searchMode, () => void shutdown());
} else {
  // Un processus, plusieurs utilisateurs : l'identité vient du jeton JWT de
  // chaque requête (sub), jamais de MCP_USER_ID.
  const http = await exitOnError(loadHttpConfig);
  stop = await exitOnError(() =>
    startHttp({
      port: http.port,
      resource: http.resource,
      issuer: http.issuer,
      scopes: [http.requiredScope],
      searchMode: config.searchMode,
      contextFor: (sessionUser) => ({ user: sessionUser, pool, retrieve }),
      auth: createJwtAuthenticator({
        issuer: http.issuer,
        audience: http.resource,
        jwksUrl: http.jwksUrl,
        requiredScope: http.requiredScope,
        users: http.users,
      }),
    }),
  );
}

// Ctrl+C envoie SIGINT ; un client stdio ferme stdin (voir startStdio).
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

/** Une ConfigError s'affiche telle quelle ; toute autre erreur aussi, sans pile. Puis exit 1. */
async function exitOnError<T>(load: () => T | Promise<T>): Promise<T> {
  try {
    return await load();
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
