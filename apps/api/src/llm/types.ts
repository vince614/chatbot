/**
 * Format neutre de la conversation. Il est défini par nous, pas par un
 * fournisseur : seul anthropic.ts sait le traduire vers les blocs du SDK.
 */

/** Un morceau de message. Un message texte simple est un raccourci pour [{ type: "text" }]. */
export type ContentPart =
  | { type: "text"; text: string }
  /** L'assistant demande l'exécution d'un outil. Uniquement dans un message "assistant". */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** Le résultat d'un appel d'outil, renvoyé au modèle. Uniquement dans un message "user". */
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

/** Un message de la conversation, côté utilisateur ou côté assistant. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string | ContentPart[];
};

/** Description d'un outil telle que le modèle la reçoit. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) d'un objet : les arguments de l'outil. */
  inputSchema: Record<string, unknown>;
}

/** Ce que le modèle émet au fil de l'eau. */
export type LlmEvent =
  /** Un fragment de la réponse textuelle. */
  | { type: "text"; text: string }
  /** Une demande d'exécution d'outil, complète (les arguments sont déjà parsés). */
  | { type: "tool_call"; id: string; name: string; input: unknown };

/**
 * Niveau d'effort du modèle (profondeur de réflexion). Le modèle actuel n'accepte
 * pas de température : l'effort est le seul réglage, et l'épingler rend les
 * réponses plus stables d'une exécution à l'autre.
 */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamChatParams {
  /** Instructions système (optionnel). */
  system?: string;
  /** Historique de la conversation, le dernier message étant celui à traiter. */
  messages: ChatMessage[];
  /** Outils que le modèle a le droit de demander (optionnel). */
  tools?: ToolDefinition[];
  /** Permet d'annuler la génération en cours (déconnexion client, Ctrl+C…). */
  signal?: AbortSignal;
  /** Effort imposé ; sinon, celui du fournisseur par défaut. */
  effort?: LlmEffort;
  /**
   * Température (0 = le plus déterministe). Transmise seulement si elle est
   * fournie : les modèles Claude récents (famille 5.x) la refusent avec une
   * erreur 400, les 4.5 l'acceptent. Utilisée par le juge de l'évaluation.
   */
  temperature?: number;
}

/**
 * Abstraction d'un fournisseur de LLM. Le reste de l'application ne connaît
 * que cette interface : aucun type du SDK ne sort de src/llm/.
 */
export interface LlmClient {
  /** Renvoie la réponse sous forme d'événements (texte, appels d'outils), au fil de l'eau. */
  streamChat(params: StreamChatParams): AsyncIterable<LlmEvent>;
}

/** Options nécessaires pour instancier un client, quel que soit le fournisseur. */
export interface LlmClientOptions {
  provider: string;
  apiKey: string;
  model: string;
}
