import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent, createMiddleware, modelCallLimitMiddleware } from "langchain";

import { type ChatMessage, toLangChainMessages } from "../llm/index.js";
import type { SseEvent } from "../sse.js";
import { confirmationRequired, toolGuard, type ToolGuardOptions } from "../tools/index.js";

/** Nombre maximal d'appels au modèle pour une requête (un « tour » = modèle → outils → modèle). */
export const MAX_TOOL_TURNS = 5;

/** Le sous-ensemble du logger Fastify (pino) dont l'agent a besoin. */
export interface AgentLogger {
  info(details: object, message: string): void;
}

/** Le résultat d'un outil, tel que les appelants l'observent. */
export interface ToolOutcome {
  ok: boolean;
  /** Ce que le modèle a lu : le résultat, ou le message d'erreur. */
  content: string;
  /** Vrai si l'outil n'a pas été exécuté faute de confirmation (effet de bord). */
  needsConfirmation?: boolean;
}

export interface AgentRunOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  system: string;
  messages: ChatMessage[];
  /** Identifiant de l'utilisateur, pour les logs des outils. */
  userId: string;
  /** Envoie un événement au client (le flux SSE de /chat ; rien pour l'évaluation). */
  emit: (event: SseEvent) => void;
  log: AgentLogger;
  signal?: AbortSignal;
  /** Si vrai, émet des événements "debug" (prompt, historique, réponse brute). */
  debug?: boolean;
  /** Confirmation humaine des outils à effet de bord (voir tools/guard.ts). */
  confirm?: ToolGuardOptions["confirm"];
  /** Appelé après chaque outil, une fois son résultat connu et l'événement tool_result émis. */
  onToolResult?: (call: { name: string; input: unknown }, result: ToolOutcome) => void;
}

export interface AgentOutcome {
  /** false si le plafond de tours est atteint sans réponse finale. */
  completed: boolean;
  /** Tout le texte produit par le modèle, tous tours confondus. */
  text: string;
}

/**
 * La boucle modèle ↔ outils, confiée à `createAgent` de LangChain. Ce qu'on
 * écrivait à la main au jour 1 (appeler le modèle, exécuter les outils
 * demandés, renvoyer leurs résultats, recommencer) est fait par l'agent. Il
 * nous reste à dire ce qui est propre à l'application, sous forme de
 * middlewares :
 *  - `observe` : les événements SSE (tool_call, tool_result, debug) et les logs ;
 *  - `toolGuard` : verrou sur les effets de bord, délai, erreurs lisibles ;
 *  - `modelCallLimitMiddleware` (fourni par LangChain) : le plafond de tours.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentOutcome> {
  const { model, tools, system, messages, emit, signal, confirm } = options;

  const agent = createAgent({
    model,
    tools,
    systemPrompt: system,
    // Le premier middleware enveloppe les suivants : observe voit ce que le garde a décidé.
    middleware: [
      observe(options),
      toolGuard({ ...(confirm && { confirm }) }),
      modelCallLimitMiddleware({ runLimit: MAX_TOOL_TURNS, exitBehavior: "error" }),
    ],
  });

  let text = "";
  try {
    // streamMode "messages" : les fragments de chaque message, au fil de l'eau.
    // On ne garde que le texte du modèle ; les outils ont leurs propres événements.
    const stream = await agent.stream({ messages: toLangChainMessages(messages) }, { streamMode: "messages", signal });
    for await (const [chunk] of stream) {
      if (!AIMessageChunk.isInstance(chunk) || !chunk.text) continue;
      text += chunk.text;
      emit({ event: "delta", data: { text: chunk.text } });
    }
  } catch (error) {
    if (isModelCallLimit(error)) return { completed: false, text };
    throw error;
  }
  return { completed: true, text };
}

/** Le middleware qui raconte l'exécution : au navigateur (SSE) et aux logs. */
function observe({ userId, emit, log, debug = false, onToolResult }: AgentRunOptions) {
  let turn = 0;
  return createMiddleware({
    name: "Observe",
    wrapModelCall: async (request, handler) => {
      turn += 1;
      if (debug) {
        emit({
          event: "debug",
          data: { kind: "model_request", turn, payload: { system: request.systemPrompt, messages: request.messages.map(toDebug), tools: request.tools.map((t) => (t as { name?: string }).name) } },
        });
      }
      const response = await handler(request);
      const toolCalls = "tool_calls" in response ? (response.tool_calls ?? []) : [];
      if (debug) emit({ event: "debug", data: { kind: "model_response", turn, payload: { text: "text" in response ? response.text : "", toolCalls } } });
      if (toolCalls.length > 0) log.info({ turn, toolCalls: toolCalls.length }, "appels d'outils demandés");
      return response;
    },

    wrapToolCall: async (request, handler) => {
      const { name, args: input } = request.toolCall;
      emit({ event: "tool_call", data: { name, input } });
      const startedAt = performance.now();
      const result = await handler(request);

      const content = ToolMessage.isInstance(result) ? stringify(result.content) : "";
      const ok = !(ToolMessage.isInstance(result) && result.status === "error");
      const needsConfirmation = !ok && content === confirmationRequired(name);
      // Outil, utilisateur, durée, succès : ni les arguments ni le résultat.
      if (needsConfirmation) log.info({ tool: name, userId }, "outil à effet de bord refusé : confirmation requise");
      else log.info({ tool: name, userId, durationMs: Math.round(performance.now() - startedAt), ok }, "outil exécuté");
      emit({ event: "tool_result", data: { name, ok } });
      onToolResult?.({ name, input }, { ok, content, ...(needsConfirmation && { needsConfirmation }) });
      return result;
    },
  });
}

/** Le plafond de modelCallLimitMiddleware : LangChain n'exporte pas sa classe d'erreur, on la reconnaît à son nom. */
function isModelCallLimit(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.name === "ModelCallLimitMiddlewareError" || /model call limits? exceeded/i.test(current.message)) return true;
  }
  return false;
}

function toDebug(message: BaseMessage): object {
  return {
    type: message.type,
    content: message.content,
    ...("tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && { toolCalls: message.tool_calls }),
  };
}

function stringify(content: ToolMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
