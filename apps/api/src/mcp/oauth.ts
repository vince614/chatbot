import type { OAuthClientCredentials } from "@chatbot/rag/oauth";

/**
 * Le client OAuth de l'API : il obtient, pour chaque utilisateur, un jeton
 * d'accès au serveur MCP, et le renouvelle avant qu'il expire.
 *
 * L'API ne connaît que l'adresse du serveur MCP et ses propres identifiants
 * de client. Tout le reste se DÉCOUVRE, comme avec un serveur distant qu'on
 * n'a pas configuré soi-même :
 *  1. une requête sans jeton à /mcp → 401 + WWW-Authenticate: resource_metadata="…" ;
 *  2. ces métadonnées (RFC 9728) → l'identifiant de la ressource et son serveur d'autorisation ;
 *  3. les métadonnées du serveur d'autorisation (RFC 8414) → son point /token ;
 *  4. POST /token avec resource=<la ressource> (RFC 8707) → un jeton dont l'audience est ce serveur MCP.
 */

export interface TokenProvider {
  /** Un jeton valide pour cet utilisateur (en cache, ou demandé). */
  token(userId: string): Promise<string>;
  /** Ce jeton a été refusé (expiré plus tôt que prévu, clé changée) : ne plus le servir. */
  invalidate(userId: string, token: string): void;
}

export interface TokenProviderOptions {
  /** L'adresse du serveur MCP (MCP_HTTP_URL). */
  mcpUrl: URL;
  client: OAuthClientCredentials;
  /** Le scope demandé : le seul dont l'API a besoin (moindre privilège). */
  scope: string;
  log: { info(details: object, message: string): void };
}

/** Le serveur d'autorisation, sa ressource, ou leur dialogue ne vont pas : rien à voir avec le serveur MCP lui-même. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
}

/** On renouvelle 30 s avant l'expiration : un jeton ne doit pas expirer entre l'envoi et la vérification. */
const REFRESH_MARGIN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface Discovery {
  /** L'identifiant de la ressource, tel que le serveur MCP l'annonce. */
  resource: string;
  tokenEndpoint: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export function createTokenProvider({ mcpUrl, client, scope, log }: TokenProviderOptions): TokenProvider {
  let discovery: Promise<Discovery> | null = null;
  // Le jeton en cours de chaque utilisateur, et la demande en cours : deux
  // requêtes simultanées de bruno attendent le même jeton.
  const valid = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<CachedToken>>();

  function discover(): Promise<Discovery> {
    discovery ??= runDiscovery(mcpUrl).then(
      (found) => {
        log.info({ resource: found.resource, tokenEndpoint: found.tokenEndpoint }, "OAuth : serveur d'autorisation découvert");
        return found;
      },
      (error: unknown) => {
        // Un échec n'est pas gardé : la découverte sera retentée au prochain appel.
        discovery = null;
        throw error;
      },
    );
    return discovery;
  }

  async function requestToken(userId: string): Promise<CachedToken> {
    const { resource, tokenEndpoint } = await discover();
    const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64");
    const response = await fetchOrThrow(tokenEndpoint, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", subject: userId, resource, scope }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string") {
      // Le code OAuth (invalid_client, invalid_target…), jamais le secret.
      throw new OAuthError(`le serveur d'autorisation refuse (HTTP ${response.status}, ${String(body.error ?? "réponse invalide")})`);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 60;
    log.info({ mcpUser: userId, expiresInS: expiresIn }, "OAuth : jeton obtenu");
    return { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  }

  return {
    async token(userId) {
      const current = valid.get(userId);
      if (current && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.value;
      // Absent, bientôt expiré ou invalidé : un nouveau, sauf si un appel
      // simultané en a déjà demandé un (on attend alors le sien).
      let request = inFlight.get(userId);
      if (!request) {
        request = requestToken(userId).then(
          (fresh) => {
            valid.set(userId, fresh);
            return fresh;
          },
        ).finally(() => inFlight.delete(userId));
        inFlight.set(userId, request);
      }
      return (await request).value;
    },

    invalidate(userId, token) {
      // Synchrone : l'appel suivant à token() ne doit pas resservir ce jeton.
      if (valid.get(userId)?.value === token) valid.delete(userId);
    },
  };
}

async function runDiscovery(mcpUrl: URL): Promise<Discovery> {
  // 1. Sans jeton, le serveur MCP dit où lire ses métadonnées.
  const challenge = await fetchOrThrow(mcpUrl, { method: "GET" });
  const header = challenge.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  if (challenge.status !== 401 || !metadataUrl) {
    throw new OAuthError(`le serveur MCP n'annonce pas ses métadonnées OAuth (HTTP ${challenge.status})`);
  }

  // 2. Ses métadonnées : la ressource doit être CELLE qu'on appelle (RFC 9728 § 3.3).
  //    Sinon, un serveur pourrait nous faire demander un jeton pour un autre.
  const metadata = (await (await fetchOrThrow(metadataUrl)).json()) as { resource?: unknown; authorization_servers?: unknown };
  if (metadata.resource !== mcpUrl.href.replace(/\/$/, "")) {
    throw new OAuthError(`métadonnées de ressource incohérentes (annoncée : ${String(metadata.resource)})`);
  }
  const issuer = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers[0] : undefined;
  if (typeof issuer !== "string") throw new OAuthError("aucun serveur d'autorisation annoncé");

  // 3. Le serveur d'autorisation : son « issuer » doit être l'adresse d'où on l'a lu (RFC 8414 § 3.3).
  const asMetadata = (await (await fetchOrThrow(`${issuer}/.well-known/oauth-authorization-server`)).json()) as {
    issuer?: unknown;
    token_endpoint?: unknown;
  };
  if (asMetadata.issuer !== issuer || typeof asMetadata.token_endpoint !== "string") {
    throw new OAuthError("métadonnées du serveur d'autorisation incohérentes");
  }
  return { resource: metadata.resource, tokenEndpoint: asMetadata.token_endpoint };
}

/** fetch avec délai ; un serveur injoignable devient une OAuthError lisible. */
async function fetchOrThrow(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const code = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code : undefined;
    throw new OAuthError(`${new URL(url).host} injoignable (${code ?? (error instanceof Error ? error.name : "erreur")})`, { cause: error });
  }
}
