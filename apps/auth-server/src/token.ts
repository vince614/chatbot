import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { ACCESS_TOKEN_TYPE } from "@chatbot/rag/oauth";
import { SignJWT } from "jose";

import type { AuthServerConfig } from "./config.js";
import { SIGNING_ALG, type SigningKey } from "./keys.js";

/** Le seul type de demande accepté (voir la simplification décrite dans issueToken). */
export const GRANT_TYPE = "client_credentials";

/** Une réponse du point /token : un jeton, ou une erreur au format OAuth (RFC 6749 § 5.2). */
export type TokenResponse =
  | { status: 200; body: { access_token: string; token_type: "Bearer"; expires_in: number; scope: string }; issued: IssuedToken }
  | { status: 400 | 401; body: { error: string; error_description: string } };

/** Ce qu'on garde d'un jeton émis, pour les logs : jamais le jeton lui-même. */
export interface IssuedToken {
  sub: string;
  aud: string;
  scope: string;
  jti: string;
}

/**
 * POST /token. Le client s'authentifie (HTTP Basic), puis demande un jeton
 * pour un utilisateur (`subject`), une ressource (`resource`, RFC 8707) et
 * des scopes.
 *
 * ⚠️ Simplification de l'exercice : le vrai flux MCP est « authorization
 * code + PKCE » ; l'utilisateur se connecte et consent dans son navigateur,
 * et le client n'apprend jamais qui il est autrement que par le jeton. Ici,
 * le client confidentiel (l'API) nomme lui-même l'utilisateur : on lui fait
 * confiance comme on faisait confiance à X-User-Id. Le reste (signature,
 * audience, scopes, expiration) est vérifié comme en production.
 */
export async function issueToken(
  config: AuthServerConfig,
  key: SigningKey,
  authorization: string | undefined,
  form: URLSearchParams,
): Promise<TokenResponse> {
  const { client } = config;

  // 1. Le client : identifiant et secret, comparés en temps constant.
  const credentials = basicCredentials(authorization);
  if (!credentials || credentials.id !== client.clientId || !sameSecret(credentials.secret, client.clientSecret)) {
    return { status: 401, body: { error: "invalid_client", error_description: "Client inconnu ou secret incorrect." } };
  }

  // 2. La demande. Chaque paramètre doit apparaître une seule fois.
  if (form.get("grant_type") !== GRANT_TYPE) {
    return { status: 400, body: { error: "unsupported_grant_type", error_description: `Seul ${GRANT_TYPE} est accepté.` } };
  }
  for (const name of ["subject", "resource", "scope"]) {
    if (form.getAll(name).length > 1) return invalidRequest(`Paramètre ${name} répété.`);
  }

  const subject = form.get("subject") ?? "";
  if (!config.users.has(subject)) {
    // Même réponse pour « absent » et « inconnu ».
    return { status: 400, body: { error: "invalid_grant", error_description: "Utilisateur inconnu." } };
  }

  // 3. La ressource (RFC 8707) : elle devient l'audience du jeton. Un client
  //    ne reçoit un jeton que pour une ressource qu'on lui a ouverte.
  const resource = form.get("resource") ?? "";
  if (!client.resources.includes(resource)) {
    return { status: 400, body: { error: "invalid_target", error_description: "Ressource inconnue ou non autorisée pour ce client." } };
  }

  // 4. Les scopes : chacun doit être autorisé pour ce client. Aucun demandé : tous ceux du client.
  const requested = (form.get("scope") ?? "").split(" ").filter(Boolean);
  const scopes = requested.length > 0 ? [...new Set(requested)] : [...client.scopes];
  if (scopes.some((scope) => !client.scopes.includes(scope))) {
    return { status: 400, body: { error: "invalid_scope", error_description: "Scope non autorisé pour ce client." } };
  }

  // 5. La durée : le client peut demander plus court (la sonde s'en sert pour
  //    obtenir un jeton qui expire), jamais plus long.
  const ttl = Math.min(config.tokenTtlSeconds, positiveInt(form.get("expires_in")) ?? config.tokenTtlSeconds);

  // 6. Le jeton (RFC 9068) : qui (sub), pour quel service (aud), quels droits
  //    (scope), par quel client, jusqu'à quand. Les groupes n'y sont pas :
  //    la ressource les lit dans son annuaire.
  const jti = randomUUID();
  const scope = scopes.join(" ");
  const accessToken = await new SignJWT({ scope, client_id: client.clientId })
    .setProtectedHeader({ alg: SIGNING_ALG, typ: ACCESS_TOKEN_TYPE, kid: key.kid })
    .setIssuer(config.issuer)
    .setSubject(subject)
    .setAudience(resource)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(jti)
    .sign(key.privateKey);

  return {
    status: 200,
    body: { access_token: accessToken, token_type: "Bearer", expires_in: ttl, scope },
    issued: { sub: subject, aud: resource, scope, jti },
  };
}

function invalidRequest(description: string): TokenResponse {
  return { status: 400, body: { error: "invalid_request", error_description: description } };
}

/** « Basic base64(id:secret) » (RFC 6749 § 2.3.1 : id et secret encodés en URL), sinon null. */
function basicCredentials(authorization: string | undefined): { id: string; secret: string } | null {
  const match = /^Basic[ ]+([A-Za-z0-9+/=]+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return null;
  }
}

/** Empreintes de même longueur, comparées octet par octet jusqu'au bout. */
function sameSecret(received: string, expected: string): boolean {
  return timingSafeEqual(sha256(received), sha256(expected));
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function positiveInt(raw: string | null): number | null {
  const value = Number(raw);
  return raw !== null && Number.isInteger(value) && value > 0 ? value : null;
}
