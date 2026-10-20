import type { User } from "@chatbot/rag/users";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { identifyUser } from "../auth/fake-identity.js";
import type { McpPool } from "../mcp/index.js";

export interface McpRoutesOptions {
  mcp: McpPool;
  users: ReadonlyMap<string, User>;
}

const completeSchema = z.object({
  prompt: z.string().regex(/^[a-z_]{1,64}$/),
  argument: z.string().regex(/^[a-z_]{1,64}$/),
  value: z.string().max(200),
  /** Les arguments déjà remplis : un serveur peut s'en servir pour affiner ses propositions. */
  arguments: z.record(z.string(), z.string().max(500)).optional(),
});

/**
 * Ce que l'interface affiche du serveur MCP de l'utilisateur : les documents
 * qu'il peut joindre, les prompts qu'il peut lancer, et l'autocomplétion de
 * leurs arguments. Le contenu des ressources n'est jamais renvoyé ici :
 * c'est /chat qui les lit, au moment de les envoyer au modèle.
 *
 * Tout passe par le même pool que les outils : même session, même jeton,
 * donc les mêmes droits (bruno ne voit pas les documents RH).
 */
export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (app, { mcp, users }) => {
  app.get("/mcp/resources", (request, reply) =>
    withUser(request, reply, users, async (user) => {
      const resources = await mcp.listResources(user.id);
      return {
        resources: resources.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
      };
    }),
  );

  app.get("/mcp/prompts", (request, reply) =>
    withUser(request, reply, users, async (user) => {
      const prompts = await mcp.listPrompts(user.id);
      return {
        prompts: prompts.map(({ name, title, description, arguments: args }) => ({
          name,
          title,
          description,
          arguments: (args ?? []).map(({ name, description, required }) => ({ name, description, required: required ?? false })),
        })),
      };
    }),
  );

  app.post("/mcp/complete", (request, reply) =>
    withUser(request, reply, users, async (user) => {
      const parsed = completeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Corps de requête invalide." });
      const { prompt, argument, value, arguments: context } = parsed.data;
      const values = await mcp.completePromptArgument(user.id, prompt, { name: argument, value }, context);
      return { values };
    }),
  );
};

/** Identifie l'utilisateur (401 sinon), puis exécute `run` ; un serveur MCP injoignable donne 503. */
async function withUser(
  request: FastifyRequest,
  reply: FastifyReply,
  users: ReadonlyMap<string, User>,
  run: (user: User) => Promise<unknown>,
): Promise<unknown> {
  const user = identifyUser(request, users);
  if (!user) return reply.code(401).send({ error: "Utilisateur non identifié." });
  try {
    return await run(user);
  } catch (error) {
    request.log.warn({ userId: user.id, reason: error instanceof Error ? error.name : "erreur" }, "serveur MCP indisponible");
    return reply.code(503).send({ error: "Le serveur de documents est indisponible pour le moment." });
  }
}
