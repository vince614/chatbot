/** Un message de la conversation, côté utilisateur ou côté assistant. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export interface StreamChatParams {
  /** Instructions système (optionnel). */
  system?: string;
  /** Historique de la conversation, le dernier message étant celui à traiter. */
  messages: ChatMessage[];
  /** Permet d'annuler la génération en cours (déconnexion client, Ctrl+C…). */
  signal?: AbortSignal;
}

/**
 * Abstraction d'un fournisseur de LLM. Le reste de l'application ne connaît
 * que cette interface : aucun type du SDK ne sort de src/llm/.
 */
export interface LlmClient {
  /** Renvoie la réponse sous forme de fragments de texte, au fil de l'eau. */
  streamChat(params: StreamChatParams): AsyncIterable<string>;
}

/** Options nécessaires pour instancier un client, quel que soit le fournisseur. */
export interface LlmClientOptions {
  provider: string;
  apiKey: string;
  model: string;
}
