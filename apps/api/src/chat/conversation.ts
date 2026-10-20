import type { ChatMessage, ContentPart, LlmClient, LlmEffort, LlmEvent } from "../llm/index.js";
import type { SseEvent } from "../sse.js";
import type { ToolExecutionResult, ToolRegistry } from "../tools/index.js";

/** Nombre maximal d'allers-retours modèle → outils → modèle pour une requête. */
export const MAX_TOOL_TURNS = 5;
/** Délai d'exécution d'un outil qui n'en fixe pas lui-même (les outils MCP en fixent un). */
const TOOL_TIMEOUT_MS = 5_000;

/** Le sous-ensemble du logger Fastify (pino) dont la boucle a besoin. */
export interface ConversationLogger {
  info(details: object, message: string): void;
}

export interface ConversationOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  system: string;
  messages: ChatMessage[];
  /** Identifiant de l'utilisateur, pour les logs des outils. */
  userId: string;
  /** Envoie un événement au client (le flux SSE de /chat ; rien pour l'évaluation). */
  emit: (event: SseEvent) => void;
  log: ConversationLogger;
  signal?: AbortSignal;
  /** Si vrai, émet des événements "debug" (prompt, historique, réponse brute). */
  debug?: boolean;
  /** Effort imposé (l'évaluation l'épingle) ; sinon celui du fournisseur. */
  effort?: LlmEffort;
  /** Appelé après chaque outil, une fois son résultat connu et l'événement tool_result émis. */
  onToolResult?: (call: { name: string; input: unknown }, result: ToolExecutionResult) => void;
}

export interface ConversationOutcome {
  /** false si le plafond de tours est atteint sans réponse finale. */
  completed: boolean;
  /** Tout le texte produit par le modèle, tous tours confondus. */
  text: string;
}

type ToolCall = Extract<LlmEvent, { type: "tool_call" }>;

/**
 * La boucle d'outils. Un "tour" = un appel au modèle. Si le modèle demande des
 * outils, on les exécute, on ajoute les résultats à l'historique et on repart.
 */
export async function runConversation(options: ConversationOptions): Promise<ConversationOutcome> {
  const { llm, tools, system, messages, emit, signal, debug = false, effort } = options;
  const history: ChatMessage[] = [...messages];
  const toolDefinitions = tools.list();
  let fullText = "";

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    let text = "";
    const toolCalls: ToolCall[] = [];

    const params = { system, messages: history, tools: toolDefinitions };
    if (debug) {
      // Copie de l'historique : il sera muté après l'appel.
      emit({
        event: "debug",
        data: { kind: "model_request", turn, payload: { ...params, messages: structuredClone(history) } },
      });
    }

    const stream = llm.streamChat({ ...params, signal, ...(effort ? { effort } : {}) });
    for await (const event of stream) {
      if (event.type === "text") {
        text += event.text;
        emit({ event: "delta", data: { text: event.text } });
      } else {
        toolCalls.push(event);
      }
    }
    fullText += text;

    if (debug) {
      emit({ event: "debug", data: { kind: "model_response", turn, payload: { text, toolCalls } } });
    }

    // Pas d'appel d'outil : la réponse est finale.
    if (toolCalls.length === 0) return { completed: true, text: fullText };

    options.log.info({ turn, toolCalls: toolCalls.length }, "appels d'outils demandés");

    // Le message assistant est renvoyé tel quel au tour suivant, texte et appels compris.
    // Le fournisseur refuse un bloc texte vide : on ne l'ajoute que s'il y a du texte.
    const assistantParts: ContentPart[] = toolCalls.map((call) => ({
      type: "tool_call",
      id: call.id,
      name: call.name,
      input: call.input,
    }));
    if (text.trim() !== "") assistantParts.unshift({ type: "text", text });
    history.push({ role: "assistant", content: assistantParts });

    // Les outils d'un même tour sont indépendants : exécution en parallèle.
    const results = await Promise.all(toolCalls.map((call) => executeToolCall(call, options)));
    history.push({ role: "user", content: results });
  }

  return { completed: false, text: fullText };
}

async function executeToolCall(
  call: ToolCall,
  { tools, userId, emit, log, signal, onToolResult }: ConversationOptions,
): Promise<ContentPart> {
  emit({ event: "tool_call", data: { name: call.name, input: call.input } });

  const startedAt = performance.now();
  const result = await tools.execute(call.name, call.input, { signal, timeoutMs: TOOL_TIMEOUT_MS });
  const durationMs = Math.round(performance.now() - startedAt);

  // Outil, utilisateur, durée, succès : ni les arguments ni le résultat.
  if (result.needsConfirmation) {
    log.info({ tool: call.name, userId }, "outil à effet de bord refusé : confirmation requise");
  } else {
    log.info({ tool: call.name, userId, durationMs, ok: result.ok }, "outil exécuté");
  }
  emit({ event: "tool_result", data: { name: call.name, ok: result.ok } });
  onToolResult?.(call, result);

  return { type: "tool_result", toolCallId: call.id, content: result.content, isError: !result.ok };
}
