import { ConfigError } from "./env.js";

/**
 * Ce que les trois acteurs OAuth partagent : le serveur d'autorisation
 * (apps/auth-server) délivre les jetons, le serveur MCP (la ressource) les
 * vérifie, l'API (le client) les demande. Chacun lit le même .env
 * (apps/api/.env) : dans un vrai déploiement, ces valeurs seraient dans la
 * configuration de chaque service, et seul le client connaîtrait son secret.
 */

/** L'émetteur (claim « iss ») : l'URL du serveur d'autorisation. */
export const DEFAULT_ISSUER = "http://127.0.0.1:3200";

/** Port par défaut du serveur MCP en HTTP : ni l'API (3000), ni Vite (5173). */
export const DEFAULT_MCP_HTTP_PORT = 3100;

/**
 * Une seconde ressource, fictive : rien n'écoute à cette adresse. Le serveur
 * d'autorisation accepte d'émettre des jetons pour elle, ce qui permet de
 * montrer qu'un jeton valide, mais destiné à un autre service, est refusé
 * par le serveur MCP (claim « aud »).
 */
export const AGENDA_RESOURCE = "http://127.0.0.1:3300/agenda";

/** Les scopes. Le serveur MCP exige documents:read ; agenda:read concerne l'agenda fictif. */
export const SCOPES = {
  documents: "documents:read",
  agenda: "agenda:read",
} as const;

/** RFC 9068 : le type d'un jeton d'accès JWT (en-tête « typ »). Un jeton d'identité (OIDC) ne passe pas pour un jeton d'accès. */
export const ACCESS_TOKEN_TYPE = "at+jwt";

/** 32 caractères au moins : `openssl rand -hex 32` en donne 64. */
const MIN_SECRET_LENGTH = 32;

export function loadIssuer(): string {
  return parseUrl("AUTH_ISSUER", process.env["AUTH_ISSUER"]?.trim() || DEFAULT_ISSUER).replace(/\/$/, "");
}

/**
 * L'identifiant de la ressource MCP (RFC 8707), c'est-à-dire l'audience
 * attendue dans ses jetons. MCP_PUBLIC_URL si renseignée (l'adresse que les
 * clients utilisent), sinon http://127.0.0.1:<MCP_HTTP_PORT>/mcp.
 */
export function loadMcpResource(): string {
  const explicit = process.env["MCP_PUBLIC_URL"]?.trim();
  if (explicit) return parseUrl("MCP_PUBLIC_URL", explicit);
  return `http://127.0.0.1:${loadMcpHttpPort()}/mcp`;
}

export function loadMcpHttpPort(): number {
  return parsePort("MCP_HTTP_PORT", process.env["MCP_HTTP_PORT"]?.trim() || String(DEFAULT_MCP_HTTP_PORT));
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Les identifiants du client OAuth « API du chatbot » (OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET). */
export function loadClientCredentials(): OAuthClientCredentials {
  const clientId = process.env["OAUTH_CLIENT_ID"]?.trim() || "chatbot-api";
  const clientSecret = process.env["OAUTH_CLIENT_SECRET"]?.trim() ?? "";
  if (clientSecret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `OAUTH_CLIENT_SECRET doit faire au moins ${MIN_SECRET_LENGTH} caractères (génère-le avec : openssl rand -hex 32).`,
    );
  }
  return { clientId, clientSecret };
}

export function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`${name} doit être un port entre 1 et 65535 (reçu : "${raw}").`);
  }
  return port;
}

function parseUrl(name: string, raw: string): string {
  try {
    return new URL(raw).href.replace(/\/$/, "");
  } catch {
    throw new ConfigError(`${name} n'est pas une URL (reçu : "${raw}").`);
  }
}
