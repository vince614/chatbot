import type { webcrypto } from "node:crypto";

import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";

/** L'algorithme de signature : ECDSA P-256. Le vérificateur l'impose aussi, pour qu'un jeton ne choisisse pas son algorithme. */
export const SIGNING_ALG = "ES256";

export interface SigningKey {
  /** La clé privée : ne quitte jamais ce processus. */
  privateKey: webcrypto.CryptoKey;
  /** L'identifiant de la clé (en-tête « kid ») : le vérificateur choisit ainsi la bonne clé publique dans le JWKS. */
  kid: string;
  /** La clé publique, au format publié sur /.well-known/jwks.json. */
  publicJwk: JWK;
}

/**
 * Une paire de clés neuve à chaque démarrage, gardée en mémoire. Redémarrer
 * le serveur d'autorisation revient donc à changer de clé (rotation) : les
 * jetons déjà émis ne se vérifient plus, et les clients en redemandent un.
 * En production, la clé est conservée (KMS, HSM) et le JWKS publie
 * l'ancienne et la nouvelle pendant la rotation.
 */
export async function createSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG);
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, kid, publicJwk: { ...jwk, kid, alg: SIGNING_ALG, use: "sig" } };
}
