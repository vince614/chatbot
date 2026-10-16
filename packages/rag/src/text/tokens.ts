import { getEncoding } from "js-tiktoken";

import type { TokenCounter } from "./types.js";

/**
 * Compteur de tokens basé sur cl100k_base (le tokenizer BPE d'OpenAI).
 *
 * Ce n'est PAS le tokenizer de Voyage : les comptes diffèrent de quelques
 * pourcents. Ça suffit pour viser « environ 500 tokens » — on reste loin de la
 * limite du modèle d'embedding (32 000 tokens pour voyage-3.5).
 * Les embeddings, eux, renvoient le vrai total consommé (facturation).
 */
const encoding = getEncoding("cl100k_base");

export const countTokens: TokenCounter = (text) => encoding.encode(text).length;
