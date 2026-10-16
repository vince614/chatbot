import type { TokenCounter } from "../text/types.js";

export interface BatchLimits {
  /** Nombre maximal de textes par requête. */
  maxTexts: number;
  /** Nombre maximal de tokens (estimés) par requête. */
  maxTokens: number;
}

/**
 * Répartit des textes en lots qui respectent les deux limites. Fonction pure,
 * indépendante du fournisseur. Renvoie des listes d'indices, pour pouvoir
 * remettre les vecteurs dans l'ordre d'origine.
 */
export function planBatches(texts: string[], limits: BatchLimits, countTokens: TokenCounter): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;

  texts.forEach((text, i) => {
    const tokens = countTokens(text);
    if (current.length > 0 && (current.length >= limits.maxTexts || currentTokens + tokens > limits.maxTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(i);
    currentTokens += tokens;
  });
  if (current.length > 0) batches.push(current);

  return batches;
}
