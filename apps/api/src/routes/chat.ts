import { safeErrorReason } from "@chatbot/rag/errors";
import type { Retrieve, RetrievedChunk } from "@chatbot/rag/retrieve";
import type { User } from "@chatbot/rag/users";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { identifyUser } from "../auth/fake-identity.js";
import { type AgentRunOptions, MAX_TOOL_TURNS, runAgent } from "../chat/agent.js";
import { attachmentSchema, expandMessages, MAX_ATTACHMENTS, McpContextError, promptRefSchema } from "../chat/mcp-context.js";
import {
  createSearchResults,
  SEARCH_TOOL_NAME,
  TOOL_SYSTEM_PROMPT,
  toSourceSummary,
} from "../chat/search-results.js";
import type { RagMode } from "../config.js";
import type { ChatMessage } from "../llm/index.js";
import { loadMcpToolsOrFallback, type McpPool } from "../mcp/index.js";
import { buildRagPrompt } from "../rag/prompt.js";
import { openSseStream, type SourceSummary } from "../sse.js";

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 8_000;

/**
 * Délai maximal de la recherche documentaire. Le client d'embeddings réessaie
 * longtemps sur un quota dépassé (pensé pour l'ingestion) : un utilisateur qui
 * attend une réponse ne doit pas patienter deux minutes.
 */
const RETRIEVAL_TIMEOUT_MS = 10_000;

// Le client n'envoie que du texte : les échanges d'outils ne vivent que le temps
// d'une requête, côté serveur. Simplification voulue (voir apps/web/src/chat/useChat.ts).
// Un message de l'utilisateur peut porter des références MCP (pièces jointes,
// prompt) : l'API les résout elle-même (voir chat/mcp-context.ts).
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Le contenu est vide.").max(MAX_CONTENT_LENGTH),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS, `Au plus ${MAX_ATTACHMENTS} pièces jointes par message.`).optional(),
  prompt: promptRefSchema.optional(),
});

const chatRequestSchema = z.object({
  /**
   * Si vrai, le flux contient des événements "debug" avec le prompt système,
   * l'historique complet envoyé au modèle et sa réponse brute. Outil
   * d'apprentissage, ignoré sauf si le serveur l'autorise (CHAT_DEBUG=true) :
   * c'est le serveur, pas le client, qui décide d'exposer son prompt.
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
/** Mode tool : une recherche demandée par le modèle a échoué. Le reste du chat fonctionne. */
const SEARCH_FAILED_MESSAGE =
  "La recherche dans les documents a échoué : cette réponse ne s'appuie sur aucun document. Les autres fonctions restent disponibles ; réessaie dans un instant.";

/** Échec de la recherche documentaire : distinct d'un échec du modèle, pour un message dédié. */
class RetrievalError extends Error {
  override readonly name = "RetrievalError";
}

export interface ChatRoutesOptions {
  model: BaseChatModel;
  /** Les outils maison, les mêmes pour tous : date, calcul. */
  localTools: StructuredToolInterface[];
  /** always : recherche à chaque message ; tool : le modèle décide (voir RAG_MODE). */
  ragMode: RagMode;
  /** Mode always : la recherche, appelée directement. */
  retrieve: Retrieve;
  /** Mode tool : les serveurs MCP des utilisateurs, qui portent la recherche. */
  mcp: McpPool;
  /** Annuaire des utilisateurs (data/users.json), par identifiant. */
  users: ReadonlyMap<string, User>;
  /** CHAT_DEBUG : sans lui, le drapeau "debug" du client est ignoré. */
  debugAllowed: boolean;
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (
  app,
  { model, localTools, ragMode, retrieve, mcp, users, debugAllowed },
) => {
  app.post("/chat", async (request, reply) => {
    // 0. Qui demande ? Avant tout le reste : sans identité, ni validation du
    //    corps, ni recherche, ni appel au modèle. (Remplaçant d'authentification :
    //    voir auth/fake-identity.ts.)
    const user = identifyUser(request, users);
    if (!user) {
      // Ni l'en-tête reçu ni la raison exacte dans la réponse : absent et
      // inconnu sont indiscernables pour le client.
      request.log.warn("requête sans utilisateur identifié");
      return reply.code(401).send({ error: "Utilisateur non identifié." });
    }

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

    // Les références MCP (pièces jointes, prompts), résolues au nom de
    // l'utilisateur AVANT d'ouvrir le flux : une référence refusée reçoit une
    // réponse JSON classique (400, 503), comme un corps invalide.
    let messages: ChatMessage[];
    try {
      messages = await expandMessages(parsed.data.messages, mcp, user.id);
    } catch (error) {
      if (!(error instanceof McpContextError)) throw error;
      request.log.warn({ userId: user.id, status: error.status, reason: describeError(error.cause ?? error) }, "référence MCP refusée");
      return reply.code(error.status).send({ error: error.message });
    }

    // Si le client ferme la connexion, on annule l'appel au modèle et les outils en cours.
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());

    // On prend la main sur la réponse brute : Fastify ne la sérialisera pas.
    reply.hijack();
    const sse = openSseStream(reply.raw);

    try {
      // Ce que les deux modes partagent : la boucle d'outils, ses événements, ses logs.
      const base = {
        model,
        userId: user.id,
        emit: sse.send,
        log: request.log,
        signal: controller.signal,
        debug: debugAllowed && (parsed.data.debug ?? false),
      } satisfies Partial<AgentRunOptions>;

      let completed: boolean;
      // Mode tool : vrai si une recherche demandée par le modèle a échoué.
      let searchFailed = false;
      if (ragMode === "always") {
        // 1. Recherche à partir du texte saisi dans le dernier message (garanti
        //    par le schéma), sans ses pièces jointes ; le modèle, lui, reçoit tout.
        const question = parsed.data.messages.at(-1)!.content;
        const chunks = await searchDocuments(retrieve, question, user, controller.signal, request.log);

        // 2. Les sources partent avant le premier delta : le navigateur peut les
        //    rattacher à la réponse dès qu'elle commence.
        sse.send({ event: "sources", data: { sources: toSourceSummaries(chunks) } });

        // 3. Le dernier message devient « documents + question ». Les messages
        //    précédents restent tels quels, en texte seul.
        const prompt = buildRagPrompt(textOf(messages.at(-1)!), chunks);
        const history: ChatMessage[] = [...messages.slice(0, -1), { role: "user", content: prompt.user }];
        ({ completed } = await runAgent({
          ...base,
          tools: localTools,
          system: prompt.system,
          messages: history,
        }));
      } else {
        // 1. Les outils de cette requête : les outils maison, plus ceux du
        //    serveur MCP de cet utilisateur (démarré au besoin). Le registre
        //    est propre à la requête, car les outils MCP dépendent de l'utilisateur.
        //    Si son serveur ne répond pas, les outils maison restent, et les
        //    outils MCP sont déclarés quand même mais répondent « indisponible ».
        const results = createSearchResults();
        const mcpTools = await loadMcpToolsOrFallback(mcp, user.id, { formatResult: results.format });
        if (!mcpTools.available) request.log.warn({ userId: user.id }, "outils MCP indisponibles pour cette requête");
        const tools = [...localTools, ...mcpTools.tools];

        // 2. La conversation telle quelle : c'est le modèle qui décide de
        //    chercher. Après chaque recherche, les sources de toute la requête
        //    partent au navigateur (il remplace la liste précédente).
        ({ completed } = await runAgent({
          ...base,
          tools,
          system: TOOL_SYSTEM_PROMPT,
          messages,
          onToolResult: ({ name }, result) => {
            if (name !== SEARCH_TOOL_NAME) return;
            if (result.ok) {
              sse.send({ event: "sources", data: { sources: results.sources() } });
            } else if (!isInvalidArguments(result.content)) {
              // Le modèle a lu l'échec dans le résultat d'outil et va le dire
              // à sa façon ; l'interface, elle, recevra une erreur explicite
              // à la fin. Pas tout de suite : le navigateur arrête de lire le
              // flux au premier "error", et perdrait l'explication du modèle.
              searchFailed = true;
            }
          },
        }));
      }

      if (completed && searchFailed) {
        sse.send({ event: "error", data: { message: SEARCH_FAILED_MESSAGE } });
      } else if (completed) {
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
 * Appelle retrieve avec un délai maximal et les groupes de l'utilisateur, et
 * journalise le résultat : identifiant de l'utilisateur, nombre de passages,
 * scores, durée. Jamais la question, le contenu des passages ni les groupes.
 */
async function searchDocuments(
  retrieve: Retrieve,
  question: string,
  user: User,
  clientSignal: AbortSignal,
  log: FastifyBaseLogger,
): Promise<RetrievedChunk[]> {
  const startedAt = performance.now();
  try {
    const chunks = await retrieve(question, {
      userGroups: user.groupes,
      signal: AbortSignal.any([clientSignal, AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS)]),
    });
    log.info(
      {
        userId: user.id,
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
  return chunks.map((chunk, i) => toSourceSummary({ ...chunk, index: i + 1 }));
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/**
 * Arguments refusés par le serveur MCP (erreur JSON-RPC -32602, que le SDK
 * écrit « MCP error -32602: … ») : c'est le modèle qui s'est trompé, il peut
 * corriger au tour suivant. Ce n'est pas une recherche indisponible.
 */
function isInvalidArguments(content: string): boolean {
  return content.startsWith("MCP error -32602");
}

/**
 * Pour les logs : le type et la phrase technique de l'erreur, sans le texte
 * cité (une erreur du fournisseur peut reprendre un morceau de la requête).
 */
function describeError(error: unknown): string {
  return safeErrorReason(error);
}
