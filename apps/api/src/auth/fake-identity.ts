import type { User } from "@chatbot/rag/users";
import type { FastifyRequest } from "fastify";

/**
 * ⚠️ REMPLAÇANT D'AUTHENTIFICATION — EXERCICE UNIQUEMENT, JAMAIS EN PRODUCTION ⚠️
 *
 * L'identité est lue dans l'en-tête X-User-Id, envoyé tel quel par le
 * navigateur. N'importe qui peut écrire « X-User-Id: chloe » avec curl et
 * obtenir les droits de chloe : rien ne prouve que la personne EST chloe.
 *
 * En production, à la place :
 *   - une vraie authentification (OIDC / SAML via un fournisseur d'identité,
 *     ou une session serveur après connexion) ;
 *   - le serveur VÉRIFIE une preuve : cookie de session httpOnly, ou jeton
 *     JWT dont il contrôle la signature, l'émetteur, l'audience et l'expiration ;
 *   - les groupes viennent de cette preuve (claim « groups ») ou de
 *     l'annuaire côté serveur, jamais d'une valeur choisie par le client.
 *
 * Le reste du code ne dépend que de `User` : remplacer ce fichier par une
 * vraie authentification ne change ni la route ni la recherche.
 */

export const USER_ID_HEADER = "x-user-id";

/**
 * L'utilisateur désigné par X-User-Id, ou null si l'en-tête est absent ou
 * inconnu. Les deux cas reçoivent la même réponse (401) : l'API ne dit pas
 * quels identifiants existent.
 */
export function identifyUser(request: FastifyRequest, users: ReadonlyMap<string, User>): User | null {
  const raw = request.headers[USER_ID_HEADER];
  // Un en-tête répété arrive sous forme de tableau : ambigu, donc refusé.
  if (typeof raw !== "string") return null;
  return users.get(raw.trim()) ?? null;
}
