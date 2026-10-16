import { listVisibleDocuments } from "@chatbot/rag/db/repository";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runTool, type ToolContext } from "./shared.js";

const DESCRIPTION = `Liste les documents internes que l'utilisateur a le droit de consulter : nom du fichier, nombre de pages et date d'ingestion. Ne renvoie aucun contenu.

Utilise cet outil quand l'utilisateur demande quels documents sont disponibles, ou pour vérifier qu'un sujet est couvert avant de dire qu'une information n'existe pas.

Ne l'utilise pas pour répondre à une question sur le contenu des documents : utilise search_documents. Un document absent de la liste n'existe pas pour cet utilisateur : ne suppose pas qu'il existe ailleurs.`;

const documentSchema = z.object({
  fichier: z.string(),
  pages: z.number().int(),
  ingere_le: z.string().describe("Date et heure d'ingestion, ISO 8601"),
});

export function registerListDocuments(server: McpServer, { user, pool }: ToolContext): void {
  server.registerTool(
    "list_documents",
    {
      title: "Lister les documents",
      description: DESCRIPTION,
      // Aucun argument : inputSchema omis.
      outputSchema: { documents: z.array(documentSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool("list_documents", "Impossible de lister les documents (base indisponible). Réessaie plus tard.", async () => {
        // Le filtre par groupes est dans la requête SQL : les documents
        // interdits ne quittent jamais la base.
        const rows = await listVisibleDocuments(pool, user.groupes);
        const documents = rows.map((doc) => ({
          fichier: doc.fileName,
          pages: doc.pages,
          ingere_le: doc.ingestedAt.toISOString(),
        }));
        const text =
          documents.length === 0
            ? "Aucun document accessible à cet utilisateur."
            : documents.map((doc) => `- ${doc.fichier} : ${doc.pages} page(s), ingéré le ${doc.ingere_le}`).join("\n");
        return { content: [{ type: "text", text }], structuredContent: { documents } };
      }),
  );
}
