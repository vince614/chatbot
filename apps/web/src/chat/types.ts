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

/**
 * Message tel que l'interface le manipule. Les activités d'outils ne sont
 * qu'un affichage : elles ne sont jamais renvoyées au serveur.
 */
export type UiMessage = ChatMessage & {
  tools?: ToolActivity[];
};

export type ChatStatus = "idle" | "streaming" | "error";
