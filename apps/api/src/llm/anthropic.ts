import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ContentPart,
  LlmClient,
  LlmEvent,
  StreamChatParams,
  ToolDefinition,
} from "./types.js";

/**
 * Correspondance entre notre format neutre et celui d'Anthropic.
 *
 *   ToolDefinition { name, description, inputSchema }   → tools[]: { name, description, input_schema }
 *   part "text"                                          → bloc { type: "text", text }
 *   part "tool_call" { id, name, input }  (assistant)    → bloc { type: "tool_use", id, name, input }
 *   part "tool_result" { toolCallId, content, isError }  → bloc { type: "tool_result", tool_use_id, content, is_error }
 *                                         (user)
 *
 * Et dans le flux reçu :
 *   content_block_delta / text_delta                     → événement { type: "text" }
 *   content_block_start de type tool_use                 → on retient id et nom, on ouvre un tampon JSON
 *   content_block_delta / input_json_delta               → on accumule partial_json dans le tampon
 *   content_block_stop                                   → JSON.parse du tampon → événement { type: "tool_call" }
 *
 * Contrainte du fournisseur : les tool_result vont dans un message "user",
 * et le message "assistant" qui contient les tool_use doit être renvoyé tel
 * quel dans l'historique du tour suivant. Notre format neutre porte ces règles.
 */

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

  async *streamChat({ system, messages, tools, signal }: StreamChatParams): AsyncIterable<LlmEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: messages.map(toAnthropicMessage),
        tools: tools?.map(toAnthropicTool),
      },
      { signal },
    );

    // Un bloc tool_use arrive en plusieurs événements : on reconstitue ses
    // arguments bloc par bloc, indexés par la position du bloc dans la réponse.
    const pendingToolCalls = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            pendingToolCalls.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const pending = pendingToolCalls.get(event.index);
            if (pending) pending.json += event.delta.partial_json;
          }
          break;

        case "content_block_stop": {
          const pending = pendingToolCalls.get(event.index);
          if (pending) {
            pendingToolCalls.delete(event.index);
            yield {
              type: "tool_call",
              id: pending.id,
              name: pending.name,
              // Un outil sans argument n'émet aucun delta : le tampon reste vide.
              input: pending.json === "" ? {} : JSON.parse(pending.json),
            };
          }
          break;
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === "refusal") {
      throw new Error("Le modèle a refusé de répondre à cette requête.");
    }
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // Notre schéma est toujours un objet (généré depuis un z.object) : le
    // cast ne fait que le dire au type du SDK.
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return { role: message.role, content: message.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.content,
        is_error: part.isError,
      };
  }
}
