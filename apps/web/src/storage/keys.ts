import { ALGORITHM } from "./crypto";
import * as db from "./db";

/** Le nom de la clé dans le magasin `keys`. Une seule clé pour toutes les conversations du navigateur. */
const KEY_NAME = "conversations";

// La clé en mémoire, pour ne pas la relire à chaque écriture. Une promesse :
// deux sauvegardes simultanées attendent la même clé au lieu d'en créer deux.
let cached: Promise<CryptoKey> | null = null;

/** La clé existante, ou undefined. Ne crée rien : lire une liste ne doit pas fabriquer de clé. */
export async function findKey(): Promise<CryptoKey | undefined> {
  if (cached) return cached;
  const stored = await db.get<CryptoKey>(db.STORES.keys, KEY_NAME);
  if (stored) cached = Promise.resolve(stored);
  return stored;
}

/**
 * La clé, créée à la première écriture.
 *
 * extractable: false : ni exportKey, ni la console, ni les DevTools ne
 * donneront ses octets. Elle est rangée TELLE QUELLE dans IndexedDB : le
 * navigateur sait cloner un CryptoKey (algorithme structuré) sans l'exposer.
 * La page peut seulement s'en servir : encrypt, decrypt.
 */
export function getOrCreateKey(): Promise<CryptoKey> {
  cached ??= (async () => {
    const stored = await db.get<CryptoKey>(db.STORES.keys, KEY_NAME);
    if (stored) return stored;
    const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, ["encrypt", "decrypt"]);
    // add, pas put : si un autre onglet a créé sa clé entre-temps, on ne
    // l'écrase pas (ses conversations deviendraient illisibles), on prend la sienne.
    if (await db.addIfAbsent(db.STORES.keys, key, KEY_NAME)) return key;
    const winner = await db.get<CryptoKey>(db.STORES.keys, KEY_NAME);
    if (!winner) throw new Error("Clé introuvable après sa création.");
    return winner;
  })();
  // Un échec (IndexedDB indisponible) ne reste pas en cache.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/**
 * Oublie la clé en mémoire. À appeler après « Tout effacer » : sinon les
 * écritures suivantes chiffreraient avec une clé qui n'est plus sur le
 * disque, et ces conversations seraient illisibles au prochain chargement.
 */
export function forgetKey(): void {
  cached = null;
}
