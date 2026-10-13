import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { ChatMessage, ContentPart, LlmClient, LlmEvent } from "../llm/index.js";
import { buildRagPrompt } from "../rag/prompt.js";
import type { Retrieve, RetrievedChunk } from "../rag/retrieve.js";
import { openSseStream, type SourceSummary } from "../sse.js";
import type { ToolRegistry } from "../tools/index.js";

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 8_000;

/** Nombre maximal d'allers-retours modèle → outils → modèle pour une requête. */
const MAX_TOOL_TURNS = 5;
/** Délai maximal d'exécution d'un outil. */
const TOOL_TIMEOUT_MS = 5_000;
/**
 * Délai maximal de la recherche documentaire. Le client d'embeddings réessaie
 * longtemps sur un quota dépassé (pensé pour l'ingestion) : un utilisateur qui
 * attend une réponse ne doit pas patienter deux minutes.
 */
const RETRIEVAL_TIMEOUT_MS = 10_000;
/** Longueur de l'extrait de chaque source envoyé au navigateur. */
const EXCERPT_LENGTH = 200;

// Le client n'envoie que du texte : les échanges d'outils ne vivent que le temps
// d'une requête, côté serveur. Simplification voulue (voir apps/web/src/chat/useChat.ts).
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Le contenu est vide.").max(MAX_CONTENT_LENGTH),
});

const chatRequestSchema = z.object({
  /**
   * Si vrai, le flux contient des événements "debug" avec le prompt système,
   * l'historique complet envoyé au modèle et sa réponse brute. Outil
   * d'apprentissage : en production on retirerait ce drapeau, car il expose
   * le prompt système au client.
   */
  debug: z.boolean().optional(),
  messages: z
    .array(chatMessageSchema)
    .min(1, "Il faut au moins un message.")
    .max(MAX_MESSAGES, `Au plus ${MAX_MESSAGES} messages par requête.`)
    .refine((messages) => messages.at(-1)?.role === "user", {
      message: 'Le dernier message doit avoir le rôle "user".',
    }),
});

/** Message renvoyé au client en cas d'échec : volontairement générique. */
const GENERIC_ERROR_MESSAGE = "La génération a échoué. Réessaie dans un instant.";
const TOO_MANY_TURNS_MESSAGE =
  "Le modèle a enchaîné trop d'appels d'outils sans conclure. Réessaie en reformulant.";
const RETRIEVAL_ERROR_MESSAGE =
  "La recherche dans les documents est indisponible pour le moment : impossible de répondre avec des sources. Réessaie dans un instant.";

/** Échec de la recherche documentaire : distinct d'un échec du modèle, pour un message dédié. */
class RetrievalError extends Error {
  override readonly name = "RetrievalError";
}

export interface ChatRoutesOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  retrieve: Retrieve;
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, { llm, tools, retrieve }) => {
  app.post("/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Réponse JSON classique : le flux SSE n'est pas encore ouvert.
      return reply.code(400).send({
        error: "Corps de requête invalide.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    // Si le client ferme la connexion, on annule l'appel au modèle et les outils en cours.
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());

    // On prend la main sur la réponse brute : Fastify ne la sérialisera pas.
    reply.hijack();
    const sse = openSseStream(reply.raw);

    try {
      // 1. Recherche à partir du dernier message utilisateur (garanti par le schéma).
      const messages = parsed.data.messages;
      const question = messages.at(-1)!.content;
      const chunks = await searchDocuments(retrieve, question, controller.signal, request.log);

      // 2. Les sources partent avant le premier delta : le navigateur peut les
      //    rattacher à la réponse dès qu'elle commence.
      sse.send({ event: "sources", data: { sources: toSourceSummaries(chunks) } });

      // 3. Le dernier message devient « documents + question ». Les messages
      //    précédents restent tels quels, en texte seul.
      const prompt = buildRagPrompt(question, chunks);
      const history: ChatMessage[] = [...messages.slice(0, -1), { role: "user", content: prompt.user }];

      const completed = await runConversation({
        llm,
        tools,
        system: prompt.system,
        messages: history,
        debug: parsed.data.debug ?? false,
        signal: controller.signal,
        sse,
        log: request.log,
      });
      if (completed) {
        sse.send({ event: "done", data: {} });
      } else {
        request.log.warn({ maxTurns: MAX_TOOL_TURNS }, "trop de tours d'outils");
        sse.send({ event: "error", data: { message: TOO_MANY_TURNS_MESSAGE } });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        request.log.info("client déconnecté, génération annulée");
      } else if (error instanceof RetrievalError) {
        // Pas de réponse sans sources : on s'arrête avant d'appeler le modèle.
        request.log.error({ reason: describeError(error.cause) }, "échec de la recherche documentaire");
        sse.send({ event: "error", data: { message: RETRIEVAL_ERROR_MESSAGE } });
      } else {
        // Seul le message d'erreur technique est logué, jamais le contenu des messages.
        request.log.error({ reason: describeError(error) }, "échec de la génération");
        sse.send({ event: "error", data: { message: GENERIC_ERROR_MESSAGE } });
      }
    } finally {
      sse.close();
    }
  });
};

/**
 * Appelle retrieve avec un délai maximal, et journalise le résultat : nombre de
 * passages, scores, durée. Jamais la question ni le contenu des passages.
 */
async function searchDocuments(
  retrieve: Retrieve,
  question: string,
  clientSignal: AbortSignal,
  log: FastifyBaseLogger,
): Promise<RetrievedChunk[]> {
  const startedAt = performance.now();
  try {
    const chunks = await retrieve(question, {
      signal: AbortSignal.any([clientSignal, AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS)]),
    });
    log.info(
      {
        chunks: chunks.length,
        scores: chunks.map((chunk) => Number(chunk.score.toFixed(3))),
        durationMs: Math.round(performance.now() - startedAt),
      },
      "recherche documentaire",
    );
    return chunks;
  } catch (error) {
    // Une déconnexion du client n'est pas un échec de la recherche.
    if (clientSignal.aborted) throw error;
    throw new RetrievalError("Recherche documentaire impossible", { cause: error });
  }
}

/** Ce que le navigateur reçoit des passages : numéro, fichier, pages, score, début du texte. */
function toSourceSummaries(chunks: RetrievedChunk[]): SourceSummary[] {
  return chunks.map((chunk, i) => {
    const text = chunk.content.replace(/\s+/g, " ").trim();
    return {
      index: i + 1,
      fileName: chunk.fileName,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      score: Number(chunk.score.toFixed(3)),
      excerpt: text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text,
    };
  });
}

interface ConversationContext {
  llm: LlmClient;
  tools: ToolRegistry;
  /** Prompt système : celui du RAG, construit par buildRagPrompt. */
  system: string;
  messages: ChatMessage[];
  debug: boolean;
  signal: AbortSignal;
  sse: ReturnType<typeof openSseStream>;
  log: FastifyBaseLogger;
}

type ToolCall = Extract<LlmEvent, { type: "tool_call" }>;

/**
 * La boucle d'outils. Un "tour" = un appel au modèle. Si le modèle demande des
 * outils, on les exécute, on ajoute les résultats à l'historique et on repart.
 * Renvoie true si le modèle a conclu, false si le plafond de tours est atteint.
 */
async function runConversation({ llm, tools, system, messages, debug, signal, sse, log }: ConversationContext) {
  const history: ChatMessage[] = [...messages];
  const toolDefinitions = tools.list();

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    let text = "";
    const toolCalls: ToolCall[] = [];

    const params = { system, messages: history, tools: toolDefinitions };
    if (debug) {
      // Copie de l'historique : il sera muté après l'appel.
      sse.send({
        event: "debug",
        data: { kind: "model_request", turn, payload: { ...params, messages: structuredClone(history) } },
      });
    }

    const stream = llm.streamChat({ ...params, signal });
    for await (const event of stream) {
      if (event.type === "text") {
        text += event.text;
        sse.send({ event: "delta", data: { text: event.text } });
      } else {
        toolCalls.push(event);
      }
    }

    if (debug) {
      sse.send({ event: "debug", data: { kind: "model_response", turn, payload: { text, toolCalls } } });
    }

    // Pas d'appel d'outil : la réponse est finale.
    if (toolCalls.length === 0) return true;

    log.info({ turn, toolCalls: toolCalls.length }, "appels d'outils demandés");

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
    const results = await Promise.all(
      toolCalls.map((call) => executeToolCall(call, { tools, signal, sse, log })),
    );
    history.push({ role: "user", content: results });
  }

  return false;
}

async function executeToolCall(
  call: ToolCall,
  { tools, signal, sse, log }: Pick<ConversationContext, "tools" | "signal" | "sse" | "log">,
): Promise<ContentPart> {
  sse.send({ event: "tool_call", data: { name: call.name, input: call.input } });

  const startedAt = performance.now();
  const result = await tools.execute(call.name, call.input, { signal, timeoutMs: TOOL_TIMEOUT_MS });
  const durationMs = Math.round(performance.now() - startedAt);

  // Nom et durée seulement : ni les arguments ni le résultat.
  log.info({ tool: call.name, durationMs, ok: result.ok }, "outil exécuté");
  sse.send({ event: "tool_result", data: { name: call.name, ok: result.ok } });

  return { type: "tool_result", toolCallId: call.id, content: result.content, isError: !result.ok };
}

function describeError(error: unknown): string {
  // Une connexion refusée en IPv6 puis en IPv4 arrive sous forme d'AggregateError,
  // au message vide : on décrit plutôt chacune des erreurs regroupées.
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join(" ; ");
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
