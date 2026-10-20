import type { UiMessage } from "../chat/types";
import { decryptJson, DecryptionError, encryptJson } from "./crypto";
import * as db from "./db";
import { findKey, forgetKey, getOrCreateKey } from "./keys";
import { deriveTitle } from "./title";
import type { Conversation, ConversationListItem, StoredMessage } from "./types";

/*
 * Le dépôt des conversations : ce que le reste de l'application appelle.
 *
 * Chaque conversation est chiffrée d'un bloc avant d'être écrite : titre,
 * dates, utilisateur et messages compris. Dans IndexedDB, seul l'id est
 * lisible. La liste se construit donc en déchiffrant toutes les fiches.
 */

/** La conversation ne peut pas être lue : données corrompues, ou clé perdue ou remplacée. */
export class UnreadableConversationError extends Error {
  override readonly name = "UnreadableConversationError";
  constructor(readonly id: string, options?: ErrorOptions) {
    super("Conversation illisible : données corrompues ou clé perdue.", options);
  }
}

/** Une conversation neuve, pas encore écrite : elle le sera au premier message. */
export function newConversation(userId: string): Conversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), userId, titre: deriveTitle([]), creeLe: now, modifieLe: now, messages: [] };
}

/**
 * Les conversations de cet utilisateur, la plus récemment modifiée en
 * premier, puis les illisibles.
 *
 * Une conversation illisible apparaît pour TOUS les utilisateurs : son
 * propriétaire est chiffré avec le reste, on ne peut plus savoir à qui elle
 * était. Elle ne montre rien d'autre que son existence, et peut être supprimée.
 */
export async function listConversations(userId: string): Promise<ConversationListItem[]> {
  const records = await db.getAll<unknown>(db.STORES.conversations);
  if (records.length === 0) return [];
  // Pas de clé mais des fiches : la clé a été perdue. Toutes sont illisibles.
  const key = await findKey();
  const items = await Promise.all(records.map((record) => readListItem(key, record)));
  const readable = items
    .filter((item): item is ConversationListItem & { illisible: false } => !item.illisible)
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.modifieLe.localeCompare(a.modifieLe));
  const unreadable = items.filter((item) => item.illisible);
  return [...readable, ...unreadable];
}

/** Lève UnreadableConversationError si la fiche ne se déchiffre pas. undefined si elle n'existe pas. */
export async function loadConversation(id: string): Promise<Conversation | undefined> {
  const record = await db.get<unknown>(db.STORES.conversations, id);
  if (record === undefined) return undefined;
  const key = await findKey();
  if (!key) throw new UnreadableConversationError(id);
  try {
    return toConversation(await decryptJson(key, record));
  } catch (error) {
    throw new UnreadableConversationError(id, { cause: error });
  }
}

/**
 * Chiffre et écrit la conversation avec ces messages. Le titre suit le
 * premier message utilisateur, `modifieLe` passe à maintenant. Renvoie ce
 * qui a été écrit (en clair, pour l'interface).
 *
 * Le chiffrement a lieu AVANT la transaction : une transaction IndexedDB se
 * ferme d'elle-même si on attend autre chose qu'une de ses requêtes.
 */
export async function saveConversation(conversation: Conversation, messages: readonly UiMessage[]): Promise<Conversation> {
  const stored = toStoredMessages(messages);
  const saved: Conversation = {
    ...conversation,
    titre: deriveTitle(stored),
    modifieLe: new Date().toISOString(),
    messages: stored,
  };
  const key = await getOrCreateKey();
  await db.put(db.STORES.conversations, await encryptJson(key, saved.id, saved));
  return saved;
}

export function deleteConversation(id: string): Promise<void> {
  return db.remove(db.STORES.conversations, id);
}

/** Vide les conversations ET la clé, dans une seule transaction. Rien n'est récupérable ensuite. */
export async function wipeAll(): Promise<void> {
  await db.clear([db.STORES.conversations, db.STORES.keys]);
  forgetKey();
}

/**
 * Ce qu'on garde d'un message affiché : le texte, les sources, les pièces jointes et le prompt. Pas les
 * outils, et pas une bulle assistant vide (réponse arrêtée avant le premier mot).
 */
export function toStoredMessages(messages: readonly UiMessage[]): StoredMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.content !== "")
    .map(({ role, content, sources, attachments, prompt }) => ({
      role,
      content,
      ...(sources?.length && { sources }),
      ...(attachments?.length && { attachments }),
      ...(prompt && { prompt }),
    }));
}

async function readListItem(key: CryptoKey | undefined, record: unknown): Promise<ConversationListItem> {
  const id = recordId(record);
  if (!key) return { id, illisible: true };
  try {
    const { userId, titre, creeLe, modifieLe } = toConversation(await decryptJson(key, record));
    return { id, illisible: false, userId, titre, creeLe, modifieLe };
  } catch {
    return { id, illisible: true };
  }
}

/** L'id d'une fiche, même abîmée (c'est la clé du magasin : il est toujours là s'il s'agit d'une de nos fiches). */
function recordId(record: unknown): string {
  const id = typeof record === "object" && record !== null ? (record as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : String(id);
}

/**
 * Le JSON déchiffré a été authentifié : c'est bien ce que nous avons écrit.
 * La vérification de forme protège contre un changement de format entre deux
 * versions de l'application, pas contre une attaque.
 */
function toConversation(value: unknown): Conversation {
  const conversation = value as Partial<Conversation> | null;
  if (
    typeof conversation?.id !== "string" ||
    typeof conversation.userId !== "string" ||
    typeof conversation.titre !== "string" ||
    typeof conversation.creeLe !== "string" ||
    typeof conversation.modifieLe !== "string" ||
    !Array.isArray(conversation.messages)
  ) {
    throw new DecryptionError("Format de conversation inattendu.");
  }
  return conversation as Conversation;
}
