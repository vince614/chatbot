import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { User } from "@chatbot/rag/users";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { type Authenticator, type Identity, sameToken } from "../auth.js";
import { log } from "../log.js";
import { createRagServer } from "../server.js";
import { observeToolCalls } from "./tool-log.js";
import type { ToolContext } from "../tools/shared.js";

/** On n'écoute que la machine locale : ni TLS ni exposition sur le réseau (hors périmètre). */
const HOST = "127.0.0.1";
/** Une session sans requête depuis ce délai est fermée : un client parti sans DELETE ne la garde pas en mémoire. */
const SESSION_IDLE_MS = 30 * 60_000;
/** Le seul corps qu'on lit nous-mêmes est un initialize : quelques centaines d'octets. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  port: number;
  searchMode: string;
  /** Le contexte des outils pour cet utilisateur (base et recherche partagées, utilisateur propre). */
  contextFor: (user: User) => ToolContext;
  /** Vérifie le jeton de chaque requête. */
  auth: Authenticator;
}

/** Une session MCP : son transport, son serveur, et l'identité qui l'a ouverte. */
interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Fixée à l'initialize : l'utilisateur des outils, et le jeton exigé ensuite. */
  identity: Identity;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Transport Streamable HTTP : un seul endpoint, /mcp. Le client y envoie ses
 * messages JSON-RPC en POST ; le serveur répond en JSON ou en flux SSE. Un
 * processus sert plusieurs clients, chacun dans sa session.
 *
 * Renvoie la fonction d'arrêt.
 */
export async function startHttp({ port, searchMode, contextFor, auth }: HttpOptions): Promise<() => Promise<void>> {
  const sessions = new Map<string, Session>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`requête en échec : ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Erreur interne." });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. DNS rebinding : une page web malveillante peut faire pointer son nom
    //    de domaine vers 127.0.0.1. Son navigateur envoie alors un Host et un
    //    Origin étrangers : on les refuse avant tout le reste.
    if (!allowedHosts.has(req.headers.host ?? "") || !isLocalOrigin(req.headers.origin)) {
      return sendJson(res, 403, { error: "Hôte ou origine refusés." });
    }

    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);

    // 2. /health : sans authentification, et rien d'autre que « ok ».
    if (pathname === "/health") {
      return req.method === "GET" ? sendJson(res, 200, { status: "ok" }) : sendJson(res, 405, { error: "Méthode non autorisée." });
    }
    if (pathname !== "/mcp") return sendJson(res, 404, { error: "Introuvable." });

    // 3. Qui demande ? Le jeton, à CHAQUE requête, avant tout traitement MCP :
    //    ni le corps, ni la session ne sont lus pour un inconnu. Aucun détail
    //    dans la réponse (absent, mal formé, inconnu : même 401).
    const identity = auth.authenticate(req.headers.authorization);
    if (!identity) {
      log(`requête refusée (401) : jeton ${req.headers.authorization ? "inconnu ou mal formé" : "absent"}`);
      res.setHeader("WWW-Authenticate", 'Bearer realm="chatbot-rag"');
      return sendJson(res, 401, { error: "Authentification requise." });
    }

    // 4. Une session existante : le transport de cette session traite la
    //    requête (POST d'un message, GET du flux de notifications, DELETE).
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      // 404 : la spécification demande au client de rouvrir une session.
      if (!session) return sendRpcError(res, 404, "Session inconnue ou expirée : recommence par initialize.");
      // L'identifiant de session n'est pas un secret d'authentification :
      // connaître celui de chloe ne doit pas suffire à parler en son nom.
      if (!sameToken(identity, session.identity)) {
        log(`session ${short(session.id)} : jeton différent de celui qui l'a ouverte (utilisateur ${identity.user.id}), refusé`);
        return sendRpcError(res, 403, "Cette session appartient à un autre jeton.");
      }
      touch(session);
      return session.transport.handleRequest(req, res);
    }

    // 5. Pas de session : seul un initialize, en POST, peut en ouvrir une.
    if (req.method !== "POST") return sendRpcError(res, 400, "En-tête Mcp-Session-Id manquant.");
    const body = await readJson(req);
    if (body === undefined) return sendRpcError(res, 400, "Corps JSON invalide.", -32700);
    if (!isInitializeRequest(body)) return sendRpcError(res, 400, "Aucune session : commence par initialize.");

    await openSession(identity, req, res, body);
  }

  async function openSession(identity: Identity, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    // C'est le transport qui crée l'identifiant (sessionIdGenerator) pendant
    // l'initialize, et le renvoie au client dans l'en-tête Mcp-Session-Id.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        touch(session);
        log(`session ${short(id)} ouverte (utilisateur ${identity.user.id})`);
      },
    });
    // Un serveur MCP par session : ses outils voient l'utilisateur du jeton,
    // résolu (avec ses groupes) au démarrage du serveur depuis users.json.
    const server = createRagServer(contextFor(identity.user));
    const session: Session = { id: "", transport, server, identity, idleTimer: null };

    // Fermeture par DELETE, par inactivité ou à l'arrêt : la session disparaît.
    transport.onclose = () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (sessions.delete(session.id)) log(`session ${short(session.id)} fermée`);
    };

    await server.connect(transport);
    // Une ligne par appel d'outil : qui, quoi, combien de temps, dans quelle
    // session (tronquée). Jamais le jeton, les arguments ni le résultat.
    observeToolCalls(transport, ({ tool, durationMs, ok }) =>
      log(`outil ${tool} : ${ok ? "ok" : "échec"} en ${durationMs} ms (utilisateur ${identity.user.id}, session ${short(session.id)})`),
    );
    await transport.handleRequest(req, res, body);
  }

  function touch(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      log(`session ${short(session.id)} inactive, fermeture`);
      void session.server.close();
    }, SESSION_IDLE_MS);
    session.idleTimer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HOST, resolve);
  });
  log(`prêt (http://${HOST}:${port}/mcp, recherche ${searchMode})`);

  return async () => {
    await Promise.all([...sessions.values()].map((session) => session.server.close()));
    // Les flux SSE ouverts (GET /mcp) garderaient le serveur en vie.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}

/** Le début de l'identifiant suffit à suivre une session dans les logs, sans permettre de la reprendre. */
function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** Pas d'Origin (curl, client Node) : accepté. Sinon, seulement une page servie par cette machine. */
function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Les erreurs de /mcp au format JSON-RPC, que tout client MCP sait lire. */
function sendRpcError(res: ServerResponse, status: number, message: string, code = -32000): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}
