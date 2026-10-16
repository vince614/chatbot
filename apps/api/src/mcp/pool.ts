import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/** Le sous-ensemble du logger Fastify (pino) dont ce module a besoin. */
export interface McpLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface McpPoolOptions {
  log: McpLogger;
  /** Un sous-processus sans appel depuis ce délai est fermé. */
  idleMs?: number;
  /** Après un plantage ou un démarrage raté, délai avant de relancer le serveur de cet utilisateur. */
  retryDelayMs?: number;
  /** Variables ajoutées à l'environnement du serveur (l'évaluation y fixe RAG_SEARCH_MODE). */
  env?: Record<string, string>;
}

/** Le serveur MCP de cet utilisateur est arrêté et ne sera pas relancé avant la fin du délai. */
export class McpUnavailableError extends Error {
  override readonly name = "McpUnavailableError";
}

/**
 * Les serveurs MCP des utilisateurs, un sous-processus chacun. Les appelants
 * ne voient jamais de sous-processus : ils demandent « les outils de bruno »
 * ou « appelle cet outil pour bruno », et le pool démarre, réutilise ou
 * relance le serveur de bruno.
 *
 * userId doit être un utilisateur déjà résolu dans users.json : le pool
 * lance un serveur pour l'identifiant qu'on lui donne, sans vérifier.
 */
export interface McpPool {
  /** Les outils du serveur, tels qu'il les déclare (noms non préfixés). */
  listTools(userId: string): Promise<McpTool[]>;
  callTool(userId: string, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
  /** Ferme tous les sous-processus et renvoie leur nombre. Un appel suivant en relance un. */
  close(): Promise<number>;
}

/** Cinq minutes : assez pour une conversation, sans garder un processus par visiteur d'hier. */
const DEFAULT_IDLE_MS = 5 * 60_000;
/**
 * 30 secondes : assez pour qu'un serveur qui plante au démarrage (base
 * arrêtée) ne soit pas relancé à chaque message, assez court pour qu'une
 * panne passagère se répare seule.
 */
const DEFAULT_RETRY_DELAY_MS = 30_000;

/** Le point d'entrée du serveur MCP, en TypeScript : il est lancé par tsx, sans build. */
const SERVER_ENTRY = fileURLToPath(new URL("../../../mcp-server/src/index.ts", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../../../mcp-server/", import.meta.url));
/** Le chargeur de tsx, résolu depuis apps/api (où tsx est installé). */
const TSX_LOADER = import.meta.resolve("tsx");

/** Un sous-processus vivant et le client MCP qui lui parle. */
interface Connection {
  client: Client;
  pid: number | null;
  /** Appels en cours : on ne ferme jamais un serveur qui travaille. */
  active: number;
  idleTimer: NodeJS.Timeout | null;
  /** La liste des outils ne change pas pendant la vie du serveur : demandée une fois. */
  tools: Promise<McpTool[]> | null;
  /** Vrai quand c'est nous qui fermons (inactivité, arrêt) : ce n'est pas un plantage. */
  closing: boolean;
}

export function createMcpPool({
  log,
  idleMs = DEFAULT_IDLE_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  env = {},
}: McpPoolOptions): McpPool {
  // La promesse, pas la connexion : deux requêtes simultanées de bruno
  // attendent le même démarrage au lieu de lancer deux serveurs.
  const connections = new Map<string, Promise<Connection>>();
  // Le disjoncteur : utilisateur → date de la dernière panne de son serveur.
  const failedAt = new Map<string, number>();

  /** onClosed : appelé quand ce serveur s'arrête, pour le retirer du cache. */
  async function connect(userId: string, onClosed: () => void): Promise<Connection> {
    const startedAt = performance.now();
    const transport = new StdioClientTransport({
      command: process.execPath,
      // --conditions=development : @chatbot/rag se résout vers ses sources, comme pour l'API.
      args: ["--import", TSX_LOADER, "--conditions=development", SERVER_ENTRY],
      cwd: SERVER_DIR,
      // L'environnement minimal du SDK (PATH, HOME…) plus l'identité. Rien de
      // l'API (clé du LLM, etc.) ne passe : le serveur lit lui-même son .env.
      env: { ...getDefaultEnvironment(), ...env, MCP_USER_ID: userId },
      // Les logs du serveur arrivent dans ceux de l'API, préfixés de l'utilisateur.
      stderr: "pipe",
    });
    if (transport.stderr) {
      // Typé Stream par le SDK, mais c'est un PassThrough : un flux lisible.
      createInterface({ input: transport.stderr as Readable }).on("line", (line) =>
        log.info({ mcpUser: userId }, line.replace(/^\[mcp\] /, "serveur MCP : ")),
      );
    }

    const client = new Client({ name: "chatbot-api", version: "0.1.0" });
    const connection: Connection = { client, pid: null, active: 0, idleTimer: null, tools: null, closing: false };

    // Fermeture voulue (inactivité, arrêt) ou plantage : dans les deux cas, ce
    // serveur ne sert plus et sort du cache. Un plantage arme en plus le
    // disjoncteur. Les appels en cours sont rejetés par le SDK (« Connection closed »).
    client.onclose = () => {
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      onClosed();
      if (connection.closing) {
        log.info({ mcpUser: userId, mcpPid: connection.pid }, "serveur MCP fermé");
      } else if (connection.pid !== null) {
        failedAt.set(userId, Date.now());
        log.warn({ mcpUser: userId, mcpPid: connection.pid, retryInMs: retryDelayMs }, "serveur MCP arrêté de façon inattendue");
      }
    };

    // connect() lance le sous-processus puis fait la poignée de main
    // (initialize). Un serveur qui refuse de démarrer (MCP_USER_ID inconnu,
    // base arrêtée) ferme son stdout : connect() rejette.
    try {
      await client.connect(transport);
    } catch (error) {
      failedAt.set(userId, Date.now());
      // La raison exacte est déjà dans les logs : c'est la dernière ligne stderr du serveur.
      log.warn({ mcpUser: userId, retryInMs: retryDelayMs }, "le serveur MCP n'a pas pu démarrer");
      throw new McpUnavailableError("Le serveur MCP n'a pas pu démarrer.", { cause: error });
    }
    connection.pid = transport.pid;
    log.info(
      { mcpUser: userId, mcpPid: connection.pid, durationMs: Math.round(performance.now() - startedAt) },
      "serveur MCP démarré",
    );
    armIdleTimer(userId, connection);
    return connection;
  }

  function getConnection(userId: string): Promise<Connection> {
    const existing = connections.get(userId);
    if (existing) return existing;

    // Disjoncteur ouvert : on ne relance pas un serveur qui vient de tomber.
    const lastFailure = failedAt.get(userId);
    if (lastFailure !== undefined && Date.now() - lastFailure < retryDelayMs) {
      const seconds = Math.ceil((retryDelayMs - (Date.now() - lastFailure)) / 1000);
      return Promise.reject(new McpUnavailableError(`Serveur MCP indisponible, nouvel essai dans ${seconds} s.`));
    }
    failedAt.delete(userId);

    // On ne retire que cette connexion-ci : une plus récente du même
    // utilisateur a pu la remplacer entre-temps.
    const forget = () => {
      if (connections.get(userId) === pending) connections.delete(userId);
    };
    const pending = connect(userId, forget);
    connections.set(userId, pending);
    // Un démarrage raté ne reste pas en cache : sinon tous les appels suivants
    // recevraient la même erreur, pour toujours.
    pending.catch(forget);
    return pending;
  }

  function armIdleTimer(userId: string, connection: Connection): void {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
      if (connection.active > 0) return;
      log.info({ mcpUser: userId, mcpPid: connection.pid }, "serveur MCP inactif, fermeture");
      connection.closing = true;
      void connection.client.close();
    }, idleMs);
    // Le minuteur n'empêche pas un script (mcp:probe, eval) de se terminer.
    connection.idleTimer.unref();
  }

  /** Exécute fn sur la connexion de l'utilisateur en la marquant occupée. */
  async function use<T>(userId: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await getConnection(userId);
    connection.active += 1;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    try {
      return await fn(connection);
    } finally {
      connection.active -= 1;
      if (connection.active === 0) armIdleTimer(userId, connection);
    }
  }

  return {
    listTools(userId) {
      return use(userId, (connection) => {
        connection.tools ??= connection.client.listTools().then((result) => result.tools);
        return connection.tools;
      });
    },

    callTool(userId, name, args, signal) {
      return use(userId, async ({ client }) => {
        // signal : si la requête /chat est annulée, le SDK envoie au serveur
        // une notification d'annulation au lieu d'attendre la réponse.
        const result = await client.callTool(
          { name, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { signal },
        );
        return result as CallToolResult;
      });
    },

    async close() {
      const pending = [...connections.values()];
      connections.clear();
      const settled = await Promise.allSettled(pending);
      const open = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      // close() ferme le stdin du serveur, qui s'arrête de lui-même ; le SDK
      // envoie SIGTERM puis SIGKILL s'il traîne (2 s chacun).
      await Promise.all(
        open.map((connection) => {
          connection.closing = true;
          return connection.client.close();
        }),
      );
      return open.length;
    },
  };
}
