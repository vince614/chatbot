import Anthropic from "@anthropic-ai/sdk";

import type { LlmClient, StreamChatParams } from "./types.js";

/**
 * Plafond de tokens générés par réponse. En streaming le timeout HTTP n'est
 * pas un problème, on laisse donc de la marge au modèle.
 */
const MAX_OUTPUT_TOKENS = 16_000;

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamChat({ system, messages, signal }: StreamChatParams): AsyncIterable<string> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === "refusal") {
      throw new Error("Le modèle a refusé de répondre à cette requête.");
    }
  }
}
