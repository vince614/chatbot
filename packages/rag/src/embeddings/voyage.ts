import { countTokens } from "../text/tokens.js";
import { planBatches } from "./batch.js";
import { EmbeddingApiError, withRetry } from "./retry.js";
import type { EmbedDocumentsResult, EmbeddingClient, EmbedOptions } from "./types.js";

/**
 * Client Voyage AI, en appel HTTP direct (pas de SDK) : l'API tient en un
 * seul endpoint.
 *
 *   POST https://api.voyageai.com/v1/embeddings
 *   Authorization: Bearer <clé>
 *   { input: string[], model, input_type: "document" | "query", output_dimension }
 *   → { data: [{ embedding: number[], index }], usage: { total_tokens } }
 *
 * input_type fait ajouter par Voyage une consigne devant le texte
 * (« Represent the document for retrieval: » / « Represent the query for
 * retrieving supporting documents: ») : questions et passages sont projetés
 * de façon à se retrouver, même s'ils ne se ressemblent pas en surface.
 */

const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";

/** Limite de tokens par requête selon le modèle (doc Voyage). Inconnu → la plus basse. */
const MAX_TOKENS_PER_REQUEST: Record<string, number> = {
  "voyage-4-lite": 1_000_000,
  "voyage-3.5-lite": 1_000_000,
  "voyage-4": 320_000,
  "voyage-3.5": 320_000,
};
const FALLBACK_MAX_TOKENS = 120_000;

/**
 * Nos lots restent bien en dessous des limites de l'API (1000 textes) :
 * un lot plus petit coûte moins cher à refaire en cas d'erreur et donne une
 * progression plus fine. Et notre compteur de tokens n'étant pas celui de
 * Voyage, on garde 20 % de marge.
 */
const MAX_TEXTS_PER_BATCH = 128;
const TOKEN_SAFETY_MARGIN = 0.8;

const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Les quotas Voyage se comptent par minute (requêtes et tokens) : les
 * attentes cumulées (≈ 1 + 2 + 4 + 8 + 16 + 30 + 30 + 30 s) doivent couvrir
 * au moins une fenêtre complète pour qu'un 429 se résorbe.
 */
const RETRY = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 30_000 };

type InputType = "document" | "query";

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

export interface VoyageClientOptions {
  apiKey: string;
  model: string;
  dimension: number;
  /** Surchargeable pour pointer vers un faux serveur pendant un essai. */
  baseUrl?: string;
}

export class VoyageEmbeddingClient implements EmbeddingClient {
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: VoyageClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimension = options.dimension;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async embedDocuments(texts: string[], options: EmbedOptions = {}): Promise<EmbedDocumentsResult> {
    const maxTokens = (MAX_TOKENS_PER_REQUEST[this.model] ?? FALLBACK_MAX_TOKENS) * TOKEN_SAFETY_MARGIN;
    const batches = planBatches(texts, { maxTexts: MAX_TEXTS_PER_BATCH, maxTokens }, countTokens);

    const vectors: number[][] = new Array(texts.length);
    let totalTokens = 0;

    // Lots envoyés l'un après l'autre : plus lent qu'en parallèle, mais on
    // reste sous les quotas par minute sans avoir à les connaître.
    for (const [i, indices] of batches.entries()) {
      const response = await this.request(indices.map((index) => texts[index]!), "document", options.signal);
      response.data.forEach((item) => {
        vectors[indices[item.index]!] = item.embedding;
      });
      totalTokens += response.usage.total_tokens;
      options.onBatch?.({ done: i + 1, total: batches.length });
    }

    return { vectors, totalTokens };
  }

  async embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
    const response = await this.request([text], "query", options.signal);
    return response.data[0]!.embedding;
  }

  /** Un appel à l'API, avec nouvelles tentatives et vérification de la réponse. */
  private async request(input: string[], inputType: InputType, signal?: AbortSignal): Promise<VoyageResponse> {
    const response = await withRetry(() => this.post(input, inputType, signal), {
      ...RETRY,
      signal,
      onRetry: ({ attempt, delayMs, error }) => {
        const reason = error instanceof EmbeddingApiError ? `HTTP ${error.status}` : String(error);
        console.warn(`[voyage] ${reason} — tentative ${attempt + 1}/${RETRY.retries + 1} dans ${delayMs} ms`);
      },
    });

    if (response.data.length !== input.length) {
      throw new Error(`Voyage a renvoyé ${response.data.length} vecteurs pour ${input.length} textes.`);
    }
    for (const { embedding } of response.data) {
      if (embedding.length !== this.dimension) {
        throw new Error(
          `Voyage a renvoyé un vecteur de dimension ${embedding.length}, EMBEDDING_DIMENSION=${this.dimension}.`,
        );
      }
    }
    return response;
  }

  private async post(input: string[], inputType: InputType, signal?: AbortSignal): Promise<VoyageResponse> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimension,
        // Un texte trop long pour le modèle provoque une erreur plutôt qu'une
        // troncature silencieuse : nos chunks de ~500 tokens n'en approchent pas.
        truncation: false,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      // Le corps d'erreur de Voyage ({ detail: "..." }) ne contient jamais nos textes.
      const detail = await response.text().catch(() => "");
      throw new EmbeddingApiError(
        `Voyage a répondu HTTP ${response.status}${detail ? ` : ${detail.slice(0, 300)}` : ""}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return (await response.json()) as VoyageResponse;
  }
}

/** Retry-After vaut soit un nombre de secondes, soit une date HTTP. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
