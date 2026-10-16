/**
 * Chiffrement d'une valeur JSON en AES-GCM 256, avec l'API Web Crypto native.
 * Aucune bibliothèque : crypto.subtle fait le travail, ce module choisit les
 * paramètres et les explique.
 */

export const ALGORITHM = "AES-GCM";
/** 12 octets (96 bits) : la taille d'IV recommandée pour GCM (NIST SP 800-38D). */
const IV_BYTES = 12;
/** Étiquette d'authentification de 128 bits : la valeur par défaut, et la plus sûre. */
const TAG_BITS = 128;
/** Le format de la fiche chiffrée. Il fait partie des données authentifiées. */
export const FORMAT_VERSION = 1;

/** Ce qui est écrit dans IndexedDB. Seul `id` est lisible : il sert de clé au magasin. */
export interface EncryptedRecord {
  id: string;
  v: typeof FORMAT_VERSION;
  /** Tiré au hasard à CHAQUE écriture, jamais réutilisé avec la même clé. Il n'est pas secret. */
  iv: Uint8Array<ArrayBuffer>;
  /** Le JSON chiffré, suivi des 16 octets de l'étiquette d'authentification. */
  donnees: ArrayBuffer;
}

/** Déchiffrement impossible : données modifiées ou corrompues, mauvaise clé, fiche mal formée. */
export class DecryptionError extends Error {
  override readonly name = "DecryptionError";
}

/**
 * Chiffre `value` (sérialisée en JSON) pour la fiche `id`.
 *
 * L'IV est neuf à chaque appel : réécrire la même conversation produit des
 * octets différents. `id` et la version entrent dans les données
 * additionnelles authentifiées : ils ne sont pas chiffrés, mais toute
 * modification fait échouer le déchiffrement.
 */
export async function encryptJson(key: CryptoKey, id: string, value: unknown): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const donnees = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: associatedData(id), tagLength: TAG_BITS },
    key,
    plaintext,
  );
  return { id, v: FORMAT_VERSION, iv, donnees };
}

/**
 * Déchiffre une fiche lue dans IndexedDB. Lève DecryptionError si quoi que ce
 * soit cloche : GCM vérifie l'étiquette AVANT de rendre le moindre octet, on
 * n'obtient jamais un texte à moitié faux.
 */
export async function decryptJson(key: CryptoKey, record: unknown): Promise<unknown> {
  if (!isEncryptedRecord(record)) throw new DecryptionError("Fiche mal formée.");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: record.iv, additionalData: associatedData(record.id), tagLength: TAG_BITS },
      key,
      record.donnees,
    );
  } catch {
    // Web Crypto ne dit pas pourquoi (OperationError) : étiquette invalide,
    // c'est-à-dire données, IV, id modifiés, ou autre clé. C'est voulu : un
    // message plus précis aiderait un attaquant.
    throw new DecryptionError("Authentification échouée : données modifiées ou clé différente.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new DecryptionError("Contenu déchiffré illisible.");
  }
}

/**
 * Les données additionnelles authentifiées (AAD) : liées au chiffré sans être
 * chiffrées. Sans elles, recopier le `donnees` et l'`iv` de la conversation A
 * dans la fiche B serait accepté : B afficherait le contenu de A.
 */
function associatedData(id: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`chatbot/conversation/v${FORMAT_VERSION}/${id}`);
}

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<EncryptedRecord>;
  return (
    typeof record.id === "string" &&
    record.v === FORMAT_VERSION &&
    record.iv instanceof Uint8Array &&
    record.iv.length === IV_BYTES &&
    record.donnees instanceof ArrayBuffer
  );
}
