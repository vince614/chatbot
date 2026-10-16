import { setTimeout as sleep } from "node:timers/promises";

/** Erreur renvoyée par l'API d'un fournisseur, avec ce qu'il faut pour décider de réessayer. */
export class EmbeddingApiError extends Error {
  override readonly name = "EmbeddingApiError";

  constructor(
    message: string,
    readonly status: number,
    /** Délai demandé par le serveur (en-tête Retry-After), en millisecondes. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /**
   * 429 : quota dépassé (trop de requêtes ou de tokens par minute).
   * 5xx : panne passagère côté fournisseur.
   * Les autres (400 requête invalide, 401 clé refusée…) ne s'arrangeront pas
   * en réessayant : on échoue tout de suite.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RetryOptions {
  /** Nombre de nouvelles tentatives après le premier essai. */
  retries: number;
  /** Délai de la première attente ; il double à chaque tentative. */
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  /** Prévenu avant chaque attente (pour un log « nouvelle tentative dans 4 s »). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Exécute `operation` et la relance en cas d'erreur passagère, avec un délai
 * exponentiel (1 s, 2 s, 4 s…) et un peu de hasard (« jitter ») pour que
 * plusieurs clients bloqués en même temps ne reviennent pas tous à la même
 * seconde. Si le serveur indique Retry-After, on le respecte.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt > options.retries || !isTransient(error) || options.signal?.aborted) throw error;

      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jittered = exponential / 2 + Math.random() * (exponential / 2);
      const delayMs = Math.round(
        error instanceof EmbeddingApiError && error.retryAfterMs !== undefined
          ? Math.max(error.retryAfterMs, jittered)
          : jittered,
      );

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, undefined, { signal: options.signal });
    }
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof EmbeddingApiError) return error.retryable;
  // fetch lève TypeError("fetch failed") pour les erreurs réseau (DNS,
  // connexion coupée), et une TimeoutError quand AbortSignal.timeout() expire.
  // Une autre TypeError serait un bug de notre code : inutile de réessayer.
  return (
    (error instanceof TypeError && error.message === "fetch failed") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}
