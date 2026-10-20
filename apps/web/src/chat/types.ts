/** Un document joint à un message : l'URI part au serveur, le nom sert à l'affichage. */
export type Attachment = {
  uri: string;
  name: string;
};

/** Un prompt MCP choisi par l'utilisateur, avec les valeurs de ses arguments. */
export type PromptCall = {
  name: string;
  arguments: Record<string, string>;
};

/**
 * Ce que le serveur accepte. `attachments` et `prompt` ne concernent que les
 * messages `user`. Pour un message prompt, `content` est le libellé affiché :
 * le serveur l'ignore et le remplace par le prompt résolu.
 */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: string[];
  prompt?: PromptCall;
};

/** Ce que le composer remet à `send` : un texte libre, ou un prompt dont `text` est le libellé. */
export type SendInput = {
  text: string;
  attachments?: Attachment[];
  prompt?: PromptCall;
};

/** Un appel d'outil observé pendant une réponse. `ok` reste indéfini tant que l'outil tourne. */
export type ToolActivity = {
  name: string;
  input: unknown;
  ok?: boolean;
};

/** Un passage de document récupéré par le serveur. `index` est le numéro cité par le modèle : [1], [2]… */
export type Source = {
  index: number;
  fileName: string;
  pageStart: number;
  pageEnd: number;
  /** Similarité avec la question. */
  score: number;
  /** Début du passage en texte brut (tronqué côté serveur, suivi de « … »). */
  excerpt: string;
};

/**
 * Message tel que l'interface le manipule. Les activités d'outils et les
 * sources ne sont qu'un affichage : elles ne sont jamais renvoyées au serveur.
 * Les pièces jointes et le prompt, eux, repartent avec chaque message.
 */
export type UiMessage = Omit<ChatMessage, "attachments"> & {
  /** Les noms sont conservés pour l'affichage ; seules les URI repartent au serveur. */
  attachments?: Attachment[];
  tools?: ToolActivity[];
  sources?: Source[];
};

export type ChatStatus = "idle" | "streaming" | "error";

/** Les familles d'événements du journal, filtrables une à une. */
export type LogKind = "action" | "send" | "http" | "sse" | "model" | "state";

/** Une ligne du journal affiché à côté du chat (outil d'apprentissage). */
export type LogEntry = {
  id: number;
  time: string;
  kind: LogKind;
  message: string;
  /** Donnée structurée associée (événement SSE décodé, échange avec le modèle), affichée en arbre. */
  data?: unknown;
};
