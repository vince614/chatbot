import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult, PromptMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { completeFileName, documentUri, readDocumentText, timed } from "../resources/documents.js";
import type { ToolContext } from "../tools/shared.js";

/**
 * Les prompts : des modèles de demande que l'UTILISATEUR choisit (une
 * commande « / » dans l'interface). Le serveur, qui connaît ses données, sait
 * mieux que le client comment bien demander un résumé ou une comparaison.
 *
 * Un prompt peut embarquer des ressources : le texte du document part dans
 * le message, comme une pièce jointe. Les droits sont ceux de la session :
 * un document interdit donne « Document introuvable », comme la ressource.
 */
export function registerDocumentPrompts(server: McpServer, context: ToolContext): void {
  // Un argument « nom de fichier » qui se complète parmi les documents visibles.
  const fileArgument = (description: string) =>
    completable(z.string().min(1).describe(description), (value) => completeFileName(context, value ?? ""));

  server.registerPrompt(
    "resumer_document",
    {
      title: "Résumer un document",
      description: "Un résumé structuré d'un document, avec les pages de chaque point.",
      argsSchema: { fichier: fileArgument("Le document à résumer") },
    },
    ({ fichier }) =>
      timed("prompt resumer_document", context.user.id, async () =>
        result(`Résumé de ${fichier}`, [
          await embed(context, fichier),
          say(
            "Résume le document joint en 5 points au plus, du plus important au moins important. " +
              "Indique la page de chaque point entre parenthèses (p. 3). Termine par une phrase qui dit à qui s'adresse ce document.",
          ),
        ]),
      ),
  );

  server.registerPrompt(
    "comparer_documents",
    {
      title: "Comparer deux documents",
      description: "Points communs et différences entre deux documents, sous forme de tableau.",
      argsSchema: {
        fichier_a: fileArgument("Le premier document"),
        fichier_b: fileArgument("Le second document"),
      },
    },
    ({ fichier_a, fichier_b }) =>
      timed("prompt comparer_documents", context.user.id, async () =>
        result(`Comparaison de ${fichier_a} et ${fichier_b}`, [
          await embed(context, fichier_a),
          await embed(context, fichier_b),
          say(
            "Compare les deux documents joints : un tableau Markdown « Sujet | " +
              `${fichier_a} | ${fichier_b} » pour les sujets qu'ils traitent tous les deux, ` +
              "puis la liste des sujets propres à chacun. Cite les pages.",
          ),
        ]),
      ),
  );

  server.registerPrompt(
    "question_sourcee",
    {
      title: "Question avec sources",
      description: "Une question sur les documents, avec l'obligation de chercher puis de citer.",
      argsSchema: { sujet: z.string().min(1).max(500).describe("Le sujet ou la question") },
    },
    ({ sujet }) =>
      timed("prompt question_sourcee", context.user.id, async () =>
        result(`Question sourcée : ${sujet}`, [
          say(
            `Question : ${sujet}\n\n` +
              "Cherche d'abord dans les documents (fais plusieurs recherches si la question a plusieurs parties), " +
              "puis réponds en citant chaque information. Si les documents ne répondent pas, dis-le.",
          ),
        ]),
      ),
  );
}

function result(description: string, messages: PromptMessage[]): GetPromptResult {
  return { description, messages };
}

function say(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

/** Le document comme ressource embarquée : son URI, son type, son texte. */
async function embed(context: ToolContext, fileName: string): Promise<PromptMessage> {
  const text = await readDocumentText(context, fileName);
  return { role: "user", content: { type: "resource", resource: { uri: documentUri(fileName), mimeType: "text/plain", text } } };
}
