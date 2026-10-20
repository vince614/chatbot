import { ACCESS_TOKEN_TYPE } from "@chatbot/rag/oauth";
import type { User } from "@chatbot/rag/users";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/** Qui appelle, d'après un jeton dont la signature, l'émetteur, l'audience et l'expiration ont été vérifiés. */
export interface Identity {
  user: User;
  /** Le client OAuth qui a obtenu le jeton (claim client_id). */
  clientId: string;
  scopes: readonly string[];
}

/**
 * Le verdict sur une requête. Un refus porte de quoi construire la réponse
 * HTTP (RFC 6750 § 3) : 401 « présente un (autre) jeton », 403 « ton jeton
 * est bon mais ne suffit pas », 503 « je ne peux pas vérifier pour l'instant ».
 */
export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401 | 403 | 503; error?: "invalid_token" | "insufficient_scope"; description: string; reason: string };

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<AuthResult>;
}

export interface JwtAuthOptions {
  /** L'émetteur attendu (claim iss) : le serveur d'autorisation. */
  issuer: string;
  /** L'audience attendue (claim aud) : notre propre URL, l'identifiant de cette ressource. */
  audience: string;
  /** Où lire les clés publiques du serveur d'autorisation. */
  jwksUrl: URL;
  /** Le scope sans lequel /mcp refuse (403). */
  requiredScope: string;
  users: ReadonlyMap<string, User>;
}

/**
 * Vérifie les jetons JWT du serveur d'autorisation, sans jamais l'appeler
 * pour un jeton : seules ses clés publiques sont téléchargées (JWKS), puis
 * gardées en cache. Une clé inconnue (rotation) déclenche un nouveau
 * téléchargement, au plus une fois toutes les 30 s.
 *
 * Chaque contrôle a sa raison :
 *  - signature (clé du JWKS)    : le jeton vient bien du serveur d'autorisation ;
 *  - algorithms: ES256          : le jeton ne choisit pas son algorithme (ni « none », ni HS256) ;
 *  - typ: at+jwt                : c'est un jeton d'accès, pas un jeton d'identité ;
 *  - iss                        : ce serveur d'autorisation-là, pas un autre ;
 *  - aud                        : délivré POUR NOUS. Un jeton de l'agenda, même
 *                                 valide, ne vaut rien ici (et inversement) ;
 *  - exp                        : encore valide (5 s de tolérance d'horloge) ;
 *  - scope                      : le droit demandé ;
 *  - sub                        : un utilisateur de notre annuaire, dont on lit les groupes.
 */
export function createJwtAuthenticator({ issuer, audience, jwksUrl, requiredScope, users }: JwtAuthOptions): Authenticator {
  const jwks = createRemoteJWKSet(jwksUrl, { cooldownDuration: 30_000, timeoutDuration: 5_000 });

  return {
    async authenticate(authorization) {
      const token = bearerToken(authorization);
      if (token === null) {
        // Sans jeton : pas de code d'erreur (RFC 6750 § 3.1), juste l'invitation à s'authentifier.
        return { ok: false, status: 401, description: "Authentification requise.", reason: authorization ? "en-tête mal formé" : "jeton absent" };
      }

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ["ES256"],
          typ: ACCESS_TOKEN_TYPE,
          requiredClaims: ["sub", "exp", "iat", "jti"],
          clockTolerance: 5,
        }));
      } catch (error) {
        return rejection(error);
      }

      const user = users.get(payload.sub ?? "");
      if (!user) return invalidToken("utilisateur inconnu de l'annuaire");
      const clientId = typeof payload["client_id"] === "string" ? payload["client_id"] : "";
      if (!clientId) return invalidToken("claim client_id absent");

      const scopes = typeof payload["scope"] === "string" ? payload["scope"].split(" ").filter(Boolean) : [];
      if (!scopes.includes(requiredScope)) {
        return {
          ok: false,
          status: 403,
          error: "insufficient_scope",
          description: `Le scope ${requiredScope} est requis.`,
          reason: `scope insuffisant (« ${scopes.join(" ")} », utilisateur ${user.id})`,
        };
      }
      return { ok: true, identity: { user, clientId, scopes } };
    },
  };
}

/** Le jeton qui a ouvert une session et celui de cette requête désignent-ils le même utilisateur, par le même client ? */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.user.id === b.user.id && a.clientId === b.clientId;
}

/**
 * Traduit une erreur de jose. Le client reçoit un message court (il sait au
 * moins qu'un jeton expiré se renouvelle) ; la raison exacte ne va que dans
 * nos logs.
 */
function rejection(error: unknown): AuthResult {
  if (error instanceof errors.JWTExpired) {
    return { ok: false, status: 401, error: "invalid_token", description: "Jeton expiré.", reason: "jeton expiré" };
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return invalidToken(`claim ${error.claim} refusé (${error.reason})`);
  }
  if (error instanceof errors.JWKSTimeout || isNetworkError(error)) {
    // Impossible de lire les clés : ce n'est pas la faute du jeton. On refuse
    // quand même (jamais d'accès sans vérification), mais en 503.
    return { ok: false, status: 503, description: "Vérification du jeton impossible pour le moment.", reason: "JWKS injoignable" };
  }
  if (error instanceof errors.JOSEError) return invalidToken(error.code);
  return invalidToken(error instanceof Error ? error.name : "erreur inconnue");
}

function invalidToken(reason: string): AuthResult {
  return { ok: false, status: 401, error: "invalid_token", description: "Jeton invalide.", reason };
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

/** « Bearer <jeton> » (schéma insensible à la casse, RFC 6750), sinon null. */
function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}
