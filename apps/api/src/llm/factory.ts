import { AnthropicLlmClient } from "./anthropic.js";
import type { LlmClient, LlmClientOptions } from "./types.js";

const KNOWN_PROVIDERS = ["anthropic"] as const;

/** Instancie le client correspondant à LLM_PROVIDER. */
export function createLlmClient({ provider, apiKey, model }: LlmClientOptions): LlmClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicLlmClient(apiKey, model);
    default:
      throw new Error(
        `Fournisseur LLM inconnu : "${provider}". Valeurs possibles : ${KNOWN_PROVIDERS.join(", ")}.`,
      );
  }
}
