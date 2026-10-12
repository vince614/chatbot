import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { LlmClient } from "../llm/index.js";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { openSseStream } from "../sse.js";

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 8_000;

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Le contenu est vide.").max(MAX_CONTENT_LENGTH),
});

const chatRequestSchema = z.object({
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

export interface ChatRoutesOptions {
  llm: LlmClient;
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, { llm }) => {
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

    // Si le client ferme la connexion, on annule l'appel au modèle.
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());

    // On prend la main sur la réponse brute : Fastify ne la sérialisera pas.
    reply.hijack();
    const sse = openSseStream(reply.raw);

    try {
      const stream = llm.streamChat({
        system: SYSTEM_PROMPT,
        messages: parsed.data.messages,
        signal: controller.signal,
      });
      for await (const text of stream) {
        sse.send({ event: "delta", data: { text } });
      }
      sse.send({ event: "done", data: {} });
    } catch (error) {
      if (controller.signal.aborted) {
        request.log.info("client déconnecté, génération annulée");
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

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
