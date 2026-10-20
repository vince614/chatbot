// npm run auth — le serveur d'autorisation OAuth, sur AUTH_ISSUER
// (http://127.0.0.1:3200 par défaut). Il délivre des jetons JWT signés pour
// une ressource (aud) et publie sa clé publique (JWKS) : le serveur MCP
// vérifie les jetons sans jamais lui parler d'autre chose que de clés.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ConfigError } from "@chatbot/rag/env";

import { type AuthServerConfig, loadAuthServerConfig } from "./config.js";
import { createSigningKey, type SigningKey } from "./keys.js";
import { log } from "./log.js";
import { GRANT_TYPE, issueToken } from "./token.js";

const HOST = "127.0.0.1";
/** Un formulaire /token tient en quelques centaines d'octets. */
const MAX_BODY_BYTES = 16 * 1024;

const config = await loadOrExit();
const key = await createSigningKey();

const server = createServer((req, res) => {
  handle(config, key, req, res).catch((error: unknown) => {
    log(`requête en échec : ${error instanceof Error ? error.name : "erreur"}`);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    else res.end();
  });
});
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, HOST, resolve);
  });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  log(code === "EADDRINUSE" ? `le port ${config.port} est déjà utilisé (un autre « npm run auth » tourne ?)` : `écoute impossible : ${code ?? String(error)}`);
  process.exit(1);
}
log(`prêt (${config.issuer}, clé ${key.kid.slice(0, 8)}, jetons de ${config.tokenTtlSeconds} s)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

async function handle(config: AuthServerConfig, key: SigningKey, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", config.issuer);

  // 1. Les métadonnées (RFC 8414) : le client y découvre le point /token, le
  //    vérificateur l'adresse du JWKS. Rien de secret.
  if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    return sendJson(res, 200, {
      issuer: config.issuer,
      token_endpoint: `${config.issuer}/token`,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      grant_types_supported: [GRANT_TYPE],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      scopes_supported: config.client.scopes,
    });
  }

  // 2. Les clés publiques (JWKS) : de quoi VÉRIFIER une signature, jamais signer.
  if (pathname === "/.well-known/jwks.json" && req.method === "GET") {
    return sendJson(res, 200, { keys: [key.publicJwk] }, { "Cache-Control": "public, max-age=300" });
  }

  // 3. Le point /token : un formulaire, comme l'exige OAuth (pas de JSON).
  if (pathname === "/token") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "invalid_request" });
    if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      return sendJson(res, 400, { error: "invalid_request", error_description: "Corps attendu : application/x-www-form-urlencoded." });
    }
    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, { error: "invalid_request" });

    const result = await issueToken(config, key, req.headers.authorization, new URLSearchParams(body));
    if (result.status === 200) {
      const { sub, aud, scope, jti } = result.issued;
      log(`jeton émis : sub=${sub} aud=${aud} scope="${scope}" jti=${jti.slice(0, 8)} (${result.body.expires_in} s)`);
    } else {
      log(`demande refusée (${result.status}) : ${result.body.error}`);
    }
    // Un jeton ne se met jamais en cache (RFC 6749 § 5.1).
    const headers: Record<string, string> = { "Cache-Control": "no-store", Pragma: "no-cache" };
    if (result.status === 401) headers["WWW-Authenticate"] = 'Basic realm="chatbot-auth"';
    return sendJson(res, result.status, result.body, headers);
  }

  return sendJson(res, 404, { error: "not_found" });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function loadOrExit(): Promise<AuthServerConfig> {
  try {
    return await loadAuthServerConfig();
  } catch (error) {
    log(error instanceof ConfigError ? error.message : `démarrage impossible : ${String(error)}`);
    process.exit(1);
  }
}
