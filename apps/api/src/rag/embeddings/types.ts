/**
 * Abstraction d'un fournisseur d'embeddings, sur le modèle de LlmClient : le
 * reste de l'application ne connaît que cette interface, et seul le fichier
 * du fournisseur (voyage.ts) sait parler à son API.
 */
export interface EmbeddingClient {
  /** Nombre de composantes de chaque vecteur renvoyé. */
  readonly dimension: number;

  /**
   * Vectorise des passages destinés à être stockés et retrouvés. Gère le
   * découpage en lots et les nouvelles tentatives. Renvoie un vecteur par
   * texte, dans le même ordre.
   */
  embedDocuments(texts: string[], options?: EmbedOptions): Promise<EmbedDocumentsResult>;

  /** Vectorise une question de l'utilisateur, pour la comparer aux passages. */
  embedQuery(text: string, options?: EmbedOptions): Promise<number[]>;
}

export interface EmbedOptions {
  /** Permet d'annuler les appels en cours (Ctrl+C…). */
  signal?: AbortSignal;
  /** Appelé après chaque lot traité : utile pour afficher une progression. */
  onBatch?: (progress: { done: number; total: number }) => void;
}

export interface EmbedDocumentsResult {
  vectors: number[][];
  /** Tokens facturés par le fournisseur (son propre décompte, le seul qui fait foi). */
  totalTokens: number;
}

/** Options nécessaires pour instancier un client, quel que soit le fournisseur. */
export interface EmbeddingClientOptions {
  provider: string;
  apiKey: string;
  model: string;
  dimension: number;
}
