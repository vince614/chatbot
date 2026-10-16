/**
 * Une petite couche d'accès à IndexedDB, sans bibliothèque.
 *
 * IndexedDB parle par événements (onsuccess, onerror, oncomplete) : ce module
 * les transforme en promesses, et ne fait rien d'autre. Il ne sait rien des
 * conversations ni du chiffrement.
 */

const DB_NAME = "chatbot";
/** À augmenter (avec une étape dans onupgradeneeded) pour tout changement de magasins. */
const DB_VERSION = 1;

/** Les deux magasins : les conversations, et (étape 2) la clé qui les chiffre. */
export const STORES = { conversations: "conversations", keys: "keys" } as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

/** IndexedDB absent ou refusé (certains navigateurs en navigation privée, réglages de confidentialité). */
export class StorageUnavailableError extends Error {
  override readonly name = "StorageUnavailableError";
}

// Une seule connexion pour toute la page, ouverte au premier usage.
let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new StorageUnavailableError("IndexedDB n'est pas disponible dans ce navigateur."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Première ouverture, ou version plus récente que celle sur le disque :
    // c'est le seul moment où l'on peut créer des magasins.
    request.onupgradeneeded = () => {
      const db = request.result;
      // keyPath "id" : la clé de chaque fiche est son champ id.
      if (!db.objectStoreNames.contains(STORES.conversations)) db.createObjectStore(STORES.conversations, { keyPath: "id" });
      // Sans keyPath : on choisit la clé à l'écriture (un nom, « conversations »).
      if (!db.objectStoreNames.contains(STORES.keys)) db.createObjectStore(STORES.keys);
    };

    request.onsuccess = () => {
      const db = request.result;
      // Un autre onglet ouvre une version plus récente : on lui laisse la place
      // (sinon sa mise à jour resterait bloquée), on rouvrira au prochain appel.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    // Un autre onglet garde l'ancienne version ouverte et ne la ferme pas.
    request.onblocked = () => reject(new StorageUnavailableError("Base occupée par un autre onglet : ferme-le puis recharge."));
    request.onerror = () => reject(new StorageUnavailableError(request.error?.message ?? "Ouverture de la base impossible."));
  });
  // Un échec ne reste pas en cache : l'appel suivant réessaie.
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

/**
 * Exécute une opération dans une transaction et attend sa fin.
 *
 * On résout sur `oncomplete` de la transaction, pas sur `onsuccess` de la
 * requête : une écriture n'est garantie sur le disque qu'une fois la
 * transaction validée. Une transaction se valide toute seule dès qu'elle n'a
 * plus de requête en attente : on ne peut donc rien `await` d'extérieur (un
 * chiffrement, un fetch) au milieu, sinon elle se ferme.
 */
async function run<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const request = operation(tx);
    tx.oncomplete = () => resolve(request ? request.result : (undefined as T));
    // Une transaction annulée (quota dépassé, contrainte) n'a rien écrit.
    tx.onabort = () => reject(tx.error ?? new Error("Transaction annulée."));
    tx.onerror = () => reject(tx.error ?? new Error("Erreur IndexedDB."));
  });
}

export function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run(store, "readonly", (tx) => tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return run(store, "readonly", (tx) => tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

/** Écrit (ou remplace) une valeur. `key` seulement pour un magasin sans keyPath. */
export function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  return run(store, "readwrite", (tx) => {
    tx.objectStore(store).put(value, key);
  });
}

/**
 * Écrit une valeur seulement si la clé est libre (`add` échoue sur une clé
 * existante). Renvoie false si elle était déjà prise : c'est la façon
 * atomique de dire « crée-la, sauf si quelqu'un l'a fait avant moi ».
 */
export async function addIfAbsent(store: StoreName, value: unknown, key?: IDBValidKey): Promise<boolean> {
  try {
    await run(store, "readwrite", (tx) => {
      tx.objectStore(store).add(value, key);
    });
    return true;
  } catch (error) {
    // La requête refusée annule la transaction, dont l'erreur est la ConstraintError.
    if (error instanceof DOMException && error.name === "ConstraintError") return false;
    throw error;
  }
}

export function remove(store: StoreName, key: IDBValidKey): Promise<void> {
  return run(store, "readwrite", (tx) => {
    tx.objectStore(store).delete(key);
  });
}

/**
 * Vide plusieurs magasins dans UNE transaction : soit tout est effacé, soit
 * rien. On ne veut pas d'état intermédiaire (la clé partie, des conversations
 * encore là, ou l'inverse).
 */
export function clear(stores: StoreName[]): Promise<void> {
  return run(stores, "readwrite", (tx) => {
    for (const store of stores) tx.objectStore(store).clear();
  });
}
