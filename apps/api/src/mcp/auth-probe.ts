// npm run mcp:auth-probe — chaque contrôle du jeton, prouvé par une requête.
// Il faut le serveur d'autorisation (npm run auth) et le serveur MCP en HTTP
// (npm run mcp -- --transport http). Aucun appel à Voyage ni au modèle :
// seul l'initialize MCP est envoyé.
import { AGENDA_RESOURCE, loadClientCredentials, type OAuthClientCredentials, SCOPES } from "@chatbot/rag/oauth";
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";

import { ConfigError, loadDotEnv } from "../config.js";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-probe", version: "0.1.0" } },
};

interface Outcome {
  status: number;
  /** Le code OAuth de WWW-Authenticate (ou du corps), s'il y en a un. */
  error: string;
  sessionId: string | null;
}

loadDotEnv();
let client: OAuthClientCredentials;
try {
  client = loadClientCredentials();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`[config] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
const mcpUrl = (process.env["MCP_HTTP_URL"]?.trim() || "http://127.0.0.1:3100/mcp").replace(/\/$/, "");

// 1. La découverte, comme le ferait n'importe quel client (voir oauth.ts).
const challenge = await fetch(mcpUrl);
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
if (!metadataUrl) throw new Error(`Pas de resource_metadata sur ${mcpUrl} (serveur MCP lancé en http ?)`);
const metadata = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
const issuer = metadata.authorization_servers[0]!;
const asMetadata = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as { token_endpoint: string };
console.log(`Ressource : ${metadata.resource}\nÉmetteur  : ${issuer}\n`);

const rows: { label: string; expected: string; got: string; ok: boolean }[] = [];
function check(label: string, expected: string, got: string): void {
  rows.push({ label, expected, got, ok: got === expected });
}

// 2. Le serveur d'autorisation refuse ce qu'il ne doit pas signer.
check("AS : mauvais secret client", "401 invalid_client", await tokenError({ secret: "x".repeat(64) }));
check("AS : ressource inconnue", "400 invalid_target", await tokenError({ resource: "http://127.0.0.1:9999/autre" }));
check("AS : scope non autorisé", "400 invalid_scope", await tokenError({ scope: "documents:write" }));
check("AS : utilisateur inconnu", "400 invalid_grant", await tokenError({ subject: "mallory" }));

// 3. Le serveur MCP refuse tout jeton qui n'est pas pour lui, de lui, valide et suffisant.
const good = await token({ subject: "bruno" });
check("MCP : sans jeton", "401", describe(await initialize(null)));
check("MCP : jeton illisible", "401 invalid_token", describe(await initialize("pas-un-jwt")));

const claims = decodeJwt(good);
const header = decodeProtectedHeader(good);
const unsigned = new UnsecuredJWT({ ...claims }).encode();
check("MCP : alg « none » (non signé)", "401 invalid_token", describe(await initialize(unsigned)));

const attacker = await generateKeyPair("ES256");
const forged = await new SignJWT({ ...claims, sub: "chloe" })
  .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: header.kid! })
  .sign(attacker.privateKey);
check("MCP : signé avec une autre clé (sub=chloe)", "401 invalid_token", describe(await initialize(forged)));

const tampered = `${good.split(".")[0]}.${Buffer.from(JSON.stringify({ ...claims, sub: "chloe" })).toString("base64url")}.${good.split(".")[2]}`;
check("MCP : charge modifiée (sub=chloe)", "401 invalid_token", describe(await initialize(tampered)));

const forAgenda = await token({ subject: "bruno", resource: AGENDA_RESOURCE, scope: SCOPES.documents });
check("MCP : aud = l'agenda (jeton valide, autre service)", "401 invalid_token", describe(await initialize(forAgenda)));

const agendaScope = await token({ subject: "bruno", scope: SCOPES.agenda });
check("MCP : scope agenda:read seulement", "403 insufficient_scope", describe(await initialize(agendaScope)));

const shortLived = await token({ subject: "bruno", expires_in: "1" });
process.stdout.write("(attente de l'expiration : 7 s, tolérance d'horloge comprise)\n\n");
await new Promise((resolve) => setTimeout(resolve, 7_000));
check("MCP : jeton expiré", "401 invalid_token", describe(await initialize(shortLived)));

// 4. Un jeton valide ouvre une session ; celui d'un autre utilisateur ne peut pas la reprendre.
const opened = await initialize(good);
check("MCP : jeton valide (bruno)", "200", describe(opened));
if (opened.sessionId) {
  const chloe = await token({ subject: "chloe" });
  const hijack = await post(chloe, { jsonrpc: "2.0", id: 2, method: "tools/list" }, opened.sessionId);
  check("MCP : session de bruno avec le jeton de chloe", "403", describe(hijack));
  const again = await post(await token({ subject: "bruno" }), { jsonrpc: "2.0", id: 3, method: "tools/list" }, opened.sessionId);
  check("MCP : session de bruno, nouveau jeton de bruno", "200", describe(again));
  await fetch(mcpUrl, { method: "DELETE", headers: { Authorization: `Bearer ${good}`, "Mcp-Session-Id": opened.sessionId } });
}

const width = Math.max(...rows.map((row) => row.label.length));
for (const row of rows) {
  console.log(`${row.ok ? "✓" : "✗"} ${row.label.padEnd(width)}  attendu ${row.expected.padEnd(22)} obtenu ${row.got}`);
}
const failed = rows.filter((row) => !row.ok).length;
console.log(failed === 0 ? `\n${rows.length}/${rows.length} contrôles conformes.` : `\n${failed} contrôle(s) non conforme(s).`);
process.exit(failed === 0 ? 0 : 1);

interface TokenRequest {
  subject?: string;
  resource?: string;
  scope?: string;
  secret?: string;
  expires_in?: string;
}

async function requestToken({ subject = "bruno", resource = metadata.resource, scope = SCOPES.documents, secret = client.clientSecret, expires_in }: TokenRequest) {
  const basic = Buffer.from(`${client.clientId}:${secret}`).toString("base64");
  const form = new URLSearchParams({ grant_type: "client_credentials", subject, resource, scope });
  if (expires_in) form.set("expires_in", expires_in);
  const response = await fetch(asMetadata.token_endpoint, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as { access_token?: string; error?: string } };
}

async function token(request: TokenRequest): Promise<string> {
  const { status, body } = await requestToken(request);
  if (!body.access_token) throw new Error(`Jeton refusé (${status} ${body.error}) pour ${JSON.stringify(request)}`);
  return body.access_token;
}

async function tokenError(request: TokenRequest): Promise<string> {
  const { status, body } = await requestToken(request);
  return `${status} ${body.error ?? "(jeton émis)"}`;
}

function initialize(bearer: string | null): Promise<Outcome> {
  return post(bearer, INITIALIZE, null);
}

async function post(bearer: string | null, message: object, sessionId: string | null): Promise<Outcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["Mcp-Protocol-Version"] = "2025-06-18";
  }
  const response = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(message) });
  await response.text();
  const challengeError = /error="([^"]+)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1] ?? "";
  return { status: response.status, error: challengeError, sessionId: response.headers.get("mcp-session-id") };
}

function describe({ status, error }: Outcome): string {
  return error ? `${status} ${error}` : String(status);
}
