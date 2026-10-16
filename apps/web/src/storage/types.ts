import type { Source } from "../chat/types";

/**
 * Un message tel qu'il est conservé : le texte, et les sources affichées sous
 * une réponse. Les échanges d'outils (UiMessage.tools) ne sont pas conservés :
 * c'est un affichage du moment, comme le serveur qui les oublie après chaque
 * requête.
 */
export type StoredMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

/**
 * Une conversation. Les dates sont des chaînes ISO 8601 : elles passent
 * telles quelles en JSON, ce qui comptera quand la conversation sera
 * chiffrée d'un bloc (étape 2), et elles se trient comme du texte.
 */
export interface Conversation {
  id: string;
  /** L'utilisateur (fictif) à qui elle appartient : ses messages contiennent les extraits de SES documents. */
  userId: string;
  titre: string;
  creeLe: string;
  modifieLe: string;
  messages: StoredMessage[];
}

/**
 * Une ligne de la liste du panneau, sans les messages. Une fiche qui ne se
 * déchiffre pas n'a que son id : tout le reste était chiffré avec elle.
 */
export type ConversationListItem =
  | ({ illisible: false } & Pick<Conversation, "id" | "userId" | "titre" | "creeLe" | "modifieLe">)
  | { id: string; illisible: true };
