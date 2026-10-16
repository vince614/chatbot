import { createHash, timingSafeEqual } from "node:crypto";

import type { McpToken } from "@chatbot/rag/mcp-tokens";
import type { User } from "@chatbot/rag/users";

/** Qui appelle, d'après son jeton. `digest` identifie le jeton sans le garder en clair. */
export interface Identity {
  user: User;
  digest: Buffer;
}

export interface Authenticator {
  /** L'identité portée par l'en-tête Authorization, ou null (absent, mal formé, inconnu). */
  authenticate(authorization: string | undefined): Identity | null;
}

/**
 * Vérifie les jetons en temps constant.
 *
 * Une recherche directe (`tokens.get(jeton)`, ou `===`) s'arrête au premier
 * caractère différent : un attaquant qui mesure les temps de réponse peut
 * deviner un jeton caractère par caractère. Ici :
 *  - on compare des empreintes SHA-256 : même longueur (32 octets) quel que
 *    soit le jeton reçu, ce qu'exige timingSafeEqual ;
 *  - timingSafeEqual compare tous les octets, même après une différence ;
 *  - on compare à TOUS les jetons, sans sortir de la boucle : le temps ne dit
 *    pas non plus lequel a correspondu, ni à quelle position.
 */
export function createAuthenticator(tokens: readonly McpToken[]): Authenticator {
  const entries = tokens.map(({ token, user }) => ({ digest: sha256(token), user }));

  return {
    authenticate(authorization) {
      const token = bearerToken(authorization);
      if (token === null) return null;
      const digest = sha256(token);
      let match: (typeof entries)[number] | null = null;
      for (const entry of entries) {
        if (timingSafeEqual(digest, entry.digest)) match = entry;
      }
      return match ? { user: match.user, digest: match.digest } : null;
    },
  };
}

/** Le jeton qui a ouvert une session est-il celui de cette requête ? En temps constant, lui aussi. */
export function sameToken(a: Identity, b: Identity): boolean {
  return timingSafeEqual(a.digest, b.digest);
}

/** « Bearer <jeton> » (schéma insensible à la casse, RFC 6750), sinon null. */
function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}
