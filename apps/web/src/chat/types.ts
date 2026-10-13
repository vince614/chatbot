/** Ce que le serveur accepte : du texte, rien d'autre. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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
 */
export type UiMessage = ChatMessage & {
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
