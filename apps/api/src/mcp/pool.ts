import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { safeErrorReason } from "@chatbot/rag/errors";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { OAuthError, type TokenProvider } from "./oauth.js";

/** Le sous-ensemble du logger Fastify (pino) dont ce module a besoin. */
export interface McpLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/**
 * Comment joindre le serveur MCP d'un utilisateur.
 *  - stdio : un sous-processus par utilisateur, lancé avec MCP_USER_ID ;
 *  - http : une session par utilisateur sur un serveur distant, avec un
 *    jeton OAuth de cet utilisateur, obtenu et renouvelé par `tokens`.
 */
export type McpTransportConfig =
  | { kind: "stdio" }
  | { kind: "http"; url: URL; tokens: TokenProvider };

export interface McpPoolOptions {
  log: McpLogger;
  /** stdio par défaut. */
  transport?: McpTransportConfig;
  /** Une connexion sans appel depuis ce délai est fermée. */
  idleMs?: number;
  /** Après une panne ou un démarrage raté, délai avant de réessayer pour cet utilisateur. */
  retryDelayMs?: number;
  /** stdio : variables ajoutées à l'environnement du serveur (l'évaluation y fixe RAG_SEARCH_MODE). */
  env?: Record<string, string>;
}

/** Le serveur MCP de cet utilisateur est injoignable, et on ne réessaiera pas avant la fin du délai. */
export class McpUnavailableError extends Error {
  override readonly name = "McpUnavailableError";
}

/**
 * Les serveurs MCP des utilisateurs, une connexion chacun. Les appelants ne
 * voient jamais ni sous-processus ni session HTTP : ils demandent « les
 * outils de bruno » ou « appelle cet outil pour bruno », et le pool ouvre,
 * réutilise ou rouvre la connexion de bruno.
 *
 * userId doit être un utilisateur déjà résolu dans users.json : le pool
 * se connecte pour l'identifiant qu'on lui donne, sans vérifier.
 */
export interface McpPool {
  /** Les outils du serveur, tels qu'il les déclare (noms non préfixés). */
  listTools(userId: string): Promise<McpTool[]>;
  callTool(userId: string, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
  /** Les ressources que cet utilisateur peut lire (documents visibles, catalogue). */
  listResources(userId: string): Promise<Resource[]>;
  readResource(userId: string, uri: string): Promise<ReadResourceResult>;
  listPrompts(userId: string): Promise<Prompt[]>;
  getPrompt(userId: string, name: string, args: Record<string, string>): Promise<GetPromptResult>;
  /** Les valeurs proposées pour un argument de prompt, d'après ce qui est déjà tapé. */
  completePromptArgument(userId: string, prompt: string, argument: { name: string; value: string }, context?: Record<string, string>): Promise<string[]>;
  /** Ferme toutes les connexions et renvoie leur nombre. Un appel suivant en rouvre une. */
  close(): Promise<number>;
}

/** Cinq minutes : assez pour une conversation, sans garder une connexion par visiteur d'hier. */
const DEFAULT_IDLE_MS = 5 * 60_000;
/**
 * 30 secondes : assez pour qu'un serveur qui plante au démarrage (base
 * arrêtée) ne soit pas relancé à chaque message, assez court pour qu'une
 * panne passagère se répare seule.
 */
const DEFAULT_RETRY_DELAY_MS = 30_000;
/**
 * Le SDK coupe toute requête au bout de 60 s par défaut, sans regarder notre
 * signal. Le vrai délai est celui du registre (15 s pour /chat, 120 s pour
 * l'évaluation), qui annule par le signal : on recule donc celui du SDK pour
 * qu'il ne passe jamais avant. Sans cela, une recherche qui attend le quota de
 * Voyage plus de 60 s échouait en « serveur indisponible ».
 */
const SDK_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** Le point d'entrée du serveur MCP, en TypeScript : il est lancé par tsx, sans build. */
const SERVER_ENTRY = fileURLToPath(new URL("../../../mcp-server/src/index.ts", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../../../mcp-server/", import.meta.url));
/** Le chargeur de tsx, résolu depuis apps/api (où tsx est installé). */
const TSX_LOADER = import.meta.resolve("tsx");

/** Les messages de log de chaque transport : en stdio, ceux d'avant (voir jour-4-client-mcp). */
const MESSAGES = {
  stdio: {
    opened: "serveur MCP démarré",
    closed: "serveur MCP fermé",
    idle: "serveur MCP inactif, fermeture",
    failed: "le serveur MCP n'a pas pu démarrer",
  },
  http: {
    opened: "session MCP ouverte",
    closed: "session MCP fermée",
    idle: "session MCP inactive, fermeture",
    failed: "le serveur MCP n'a pas pu être joint",
  },
} as const;

/** Une connexion ouverte et le client MCP qui l'utilise. */
interface Connection {
  client: Client;
  /** Ce qui l'identifie dans les logs : { mcpPid } en stdio, { mcpSession } (tronqué) en http. */
  tag: Record<string, unknown>;
  /** http : met fin à la session côté serveur (DELETE) avant de fermer. */
  terminate: (() => Promise<void>) | null;
  /** Vrai une fois la poignée de main faite. */
  connected: boolean;
  /** Retire cette connexion du cache (sans effet si une plus récente l'a remplacée). */
  evict: () => void;
  /** Appels en cours : on ne ferme jamais une connexion qui travaille. */
  active: number;
  idleTimer: NodeJS.Timeout | null;
  /** La liste des outils ne change pas pendant la vie du serveur : demandée une fois. */
  tools: Promise<McpTool[]> | null;
  /** Vrai quand c'est nous qui fermons (inactivité, arrêt, panne constatée) : onclose n'a rien à ajouter. */
  closing: boolean;
}

export function createMcpPool({
  log,
  transport: transportConfig = { kind: "stdio" },
  idleMs = DEFAULT_IDLE_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  env = {},
}: McpPoolOptions): McpPool {
  // La promesse, pas la connexion : deux requêtes simultanées de bruno
  // attendent la même connexion au lieu d'en ouvrir deux.
  const connections = new Map<string, Promise<Connection>>();
  // Le disjoncteur : utilisateur → date de la dernière panne de son serveur.
  const failedAt = new Map<string, number>();
  const messages = MESSAGES[transportConfig.kind];

  /** stdio : le sous-processus de cet utilisateur, son identité dans l'environnement. */
  function stdioTransport(userId: string): StdioClientTransport {
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
    return transport;
  }

  /**
   * http : une session sur le serveur distant, son identité dans le jeton de
   * chaque requête. Le jeton change (5 min) pendant la vie de la session : on
   * ne le fixe donc pas une fois pour toutes, on le demande à chaque requête
   * (fetch). Un 401 (jeton expiré plus tôt que prévu, clé du serveur
   * d'autorisation changée) : on jette ce jeton et on réessaie une fois.
   */
  function httpTransport(url: URL, userId: string, tokens: TokenProvider): StreamableHTTPClientTransport {
    const send = (input: string | URL, init: RequestInit | undefined, token: string) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    return new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const token = await tokens.token(userId);
        const response = await send(input, init, token);
        if (response.status !== 401) return response;
        tokens.invalidate(userId, token);
        log.info({ mcpUser: userId }, "jeton MCP refusé (401), nouveau jeton");
        return send(input, init, await tokens.token(userId));
      },
    });
  }

  /** onClosed : appelé quand la connexion se ferme, pour la retirer du cache. */
  async function connect(userId: string, onClosed: () => void): Promise<Connection> {
    const startedAt = performance.now();
    const client = new Client({ name: "chatbot-api", version: "0.1.0" });
    const connection: Connection = {
      client,
      tag: {},
      terminate: null,
      connected: false,
      evict: onClosed,
      active: 0,
      idleTimer: null,
      tools: null,
      closing: false,
    };

    // Fermeture voulue (inactivité, arrêt) ou plantage : dans les deux cas, cette
    // connexion ne sert plus et sort du cache. En stdio, un plantage du
    // sous-processus arrive ici et arme le disjoncteur. En http, rien n'arrive
    // ici quand le serveur tombe : c'est l'appel suivant qui échoue (voir use).
    client.onclose = () => {
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      onClosed();
      if (connection.closing) {
        log.info({ mcpUser: userId, ...connection.tag }, messages.closed);
      } else if (connection.connected) {
        failedAt.set(userId, Date.now());
        log.warn({ mcpUser: userId, ...connection.tag, retryInMs: retryDelayMs }, "serveur MCP arrêté de façon inattendue");
      }
    };

    // connect() lance le sous-processus (stdio) ou envoie le premier POST
    // (http), puis fait la poignée de main (initialize). Un serveur qui refuse
    // (MCP_USER_ID inconnu, base arrêtée, jeton refusé, port fermé) : rejet.
    try {
      if (transportConfig.kind === "stdio") {
        const transport = stdioTransport(userId);
        await client.connect(transport);
        connection.tag = { mcpPid: transport.pid };
      } else {
        const transport = httpTransport(transportConfig.url, userId, transportConfig.tokens);
        await client.connect(transport);
        connection.tag = { mcpSession: transport.sessionId?.slice(0, 8) };
        connection.terminate = () => transport.terminateSession();
      }
    } catch (error) {
      failedAt.set(userId, Date.now());
      // La raison exacte : en stdio, la dernière ligne stderr du serveur est déjà
      // dans les logs ; en http, le message d'erreur (statut HTTP, connexion refusée).
      log.warn(
        { mcpUser: userId, retryInMs: retryDelayMs, ...(transportConfig.kind === "http" ? { reason: describe(error) } : {}) },
        messages.failed,
      );
      throw new McpUnavailableError("Le serveur MCP n'a pas pu être joint.", { cause: error });
    }
    connection.connected = true;
    log.info(
      { mcpUser: userId, ...connection.tag, durationMs: Math.round(performance.now() - startedAt) },
      messages.opened,
    );
    armIdleTimer(userId, connection);
    return connection;
  }

  function getConnection(userId: string): Promise<Connection> {
    const existing = connections.get(userId);
    if (existing) return existing;

    // Disjoncteur ouvert : on ne réessaie pas un serveur qui vient de tomber.
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

  /** Ferme une connexion de notre fait : en http, la session est d'abord terminée côté serveur. */
  async function closeConnection(connection: Connection): Promise<void> {
    connection.closing = true;
    // Tout de suite, sans attendre onclose : un appel qui suit (la seconde
    // chance de use) doit ouvrir une nouvelle connexion, pas reprendre celle-ci.
    connection.evict();
    // Un DELETE qui échoue (serveur déjà arrêté) n'empêche pas de fermer chez nous.
    await connection.terminate?.().catch(() => undefined);
    await connection.client.close();
  }

  function armIdleTimer(userId: string, connection: Connection): void {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
      if (connection.active > 0) return;
      log.info({ mcpUser: userId, ...connection.tag }, messages.idle);
      void closeConnection(connection);
    }, idleMs);
    // Le minuteur n'empêche pas un script (mcp:probe, eval) de se terminer.
    connection.idleTimer.unref();
  }

  /** Exécute fn sur la connexion de l'utilisateur en la marquant occupée. */
  async function attempt<T>(userId: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await getConnection(userId);
    connection.active += 1;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    try {
      return await fn(connection);
    } catch (error) {
      // http : le serveur n'a pas répondu (arrêté, redémarré, jeton retiré).
      // La connexion est morte sans qu'onclose l'ait dit : on la retire nous-mêmes.
      if (transportConfig.kind === "http" && isHttpFailure(error)) {
        if (!isSessionLost(error)) {
          failedAt.set(userId, Date.now());
          log.warn({ mcpUser: userId, ...connection.tag, reason: describe(error), retryInMs: retryDelayMs }, "serveur MCP injoignable");
        }
        void closeConnection(connection);
      }
      throw error;
    } finally {
      connection.active -= 1;
      if (connection.active === 0 && !connection.closing) armIdleTimer(userId, connection);
    }
  }

  /**
   * Comme attempt, avec une seconde chance si la session a disparu côté
   * serveur (404 : serveur redémarré, session expirée) : on en rouvre une
   * aussitôt, comme le demande la spécification. Le serveur répond : ce
   * n'est pas une panne, pas de disjoncteur.
   */
  async function use<T>(userId: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    try {
      return await attempt(userId, fn);
    } catch (error) {
      if (!isSessionLost(error)) throw error;
      log.info({ mcpUser: userId }, "session MCP perdue côté serveur, nouvelle session");
      return attempt(userId, fn);
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
          { signal, timeout: SDK_REQUEST_TIMEOUT_MS },
        );
        return result as CallToolResult;
      });
    },

    listResources(userId) {
      return use(userId, async ({ client }) => (await client.listResources()).resources);
    },

    readResource(userId, uri) {
      return use(userId, ({ client }) => client.readResource({ uri }));
    },

    listPrompts(userId) {
      return use(userId, async ({ client }) => (await client.listPrompts()).prompts);
    },

    getPrompt(userId, name, args) {
      return use(userId, ({ client }) => client.getPrompt({ name, arguments: args }));
    },

    completePromptArgument(userId, prompt, argument, context) {
      return use(userId, async ({ client }) => {
        const result = await client.complete({
          ref: { type: "ref/prompt", name: prompt },
          argument,
          ...(context ? { context: { arguments: context } } : {}),
        });
        return result.completion.values;
      });
    },

    async close() {
      const pending = [...connections.values()];
      connections.clear();
      const settled = await Promise.allSettled(pending);
      const open = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      // stdio : close() ferme le stdin du serveur, qui s'arrête de lui-même ; le
      // SDK envoie SIGTERM puis SIGKILL s'il traîne (2 s chacun).
      // http : DELETE de la session, le serveur partagé continue de tourner.
      await Promise.all(open.map(closeConnection));
      return open.length;
    },
  };
}

/**
 * Une erreur de transport HTTP : statut d'erreur renvoyé par le serveur
 * (StreamableHTTPError), ou serveur injoignable (fetch rejette en TypeError).
 * Une erreur MCP (McpError : outil inconnu, délai) vient d'un serveur vivant.
 */
function isHttpFailure(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError ||
    error instanceof OAuthError ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
}

/** 404 sur une session : le serveur ne la connaît plus et demande d'en ouvrir une autre. */
function isSessionLost(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

/** Statut HTTP ou cause réseau (ECONNREFUSED), jamais le jeton ni le contenu. */
function describe(error: unknown): string {
  if (error instanceof StreamableHTTPError) return `HTTP ${error.code ?? "?"}`;
  if (error instanceof OAuthError) return `OAuth : ${error.message}`;
  if (error instanceof Error && error.cause instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException).code;
    return code ?? safeErrorReason(error.cause);
  }
  return safeErrorReason(error);
}
