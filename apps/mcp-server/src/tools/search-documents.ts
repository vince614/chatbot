import { DEFAULT_K, formatPages } from "@chatbot/rag/retrieve";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runTool, type ToolContext } from "./shared.js";

/** Au-delà, le contexte du modèle se remplit de passages peu pertinents (environ 500 tokens chacun). */
const MAX_K = 10;

/*
 * La description est le seul texte qui décide le modèle à appeler l'outil.
 * Elle est la même pour tous les utilisateurs : elle ne nomme donc aucun
 * document (bruno apprendrait l'existence d'un document RH).
 */
const DESCRIPTION = `Cherche dans les documents internes de l'entreprise les passages les plus pertinents pour une question, parmi les documents que l'utilisateur a le droit de lire. Renvoie pour chaque passage le fichier, les pages, le texte et un score.

Utilise cet outil quand la question porte sur le contenu de ces documents : règles internes, procédures, avantages des salariés, projets, architecture, identifiants techniques (noms de machines, codes). Passe la question en langage naturel, en gardant les termes exacts (nom propre, identifiant). Pour une question qui combine deux sujets, fais une recherche par sujet.

Ne l'utilise pas pour une question de culture générale, d'écriture ou de code sans lien avec ces documents, ni quand les passages déjà obtenus dans la conversation suffisent. Pour savoir quels documents existent, utilise list_documents.

Réponds uniquement à partir des passages renvoyés et cite le fichier et les pages. Si aucun passage ne contient la réponse, dis que les documents ne la donnent pas, sans compléter avec tes connaissances.`;

const passageSchema = z.object({
  fichier: z.string(),
  pages: z.array(z.number().int()),
  extrait: z.string(),
  score: z.number(),
});

export function registerSearchDocuments(server: McpServer, { user, retrieve }: ToolContext): void {
  server.registerTool(
    "search_documents",
    {
      title: "Rechercher dans les documents",
      description: DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("La question ou les mots-clés à chercher, en langage naturel, avec les termes exacts."),
        k: z
          .number()
          .int()
          .min(1)
          .max(MAX_K)
          .default(DEFAULT_K)
          .describe(`Nombre de passages à renvoyer (1 à ${MAX_K}, ${DEFAULT_K} par défaut).`),
      },
      outputSchema: { passages: z.array(passageSchema) },
      // Indications pour le client : l'outil ne modifie rien et ne sort pas du système d'information.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // Les arguments arrivent déjà validés par le schéma : k est un entier entre 1 et 10.
    ({ question, k }) =>
      runTool("search_documents", "La recherche a échoué (base ou service d'embeddings indisponible). Réessaie plus tard.", async () => {
        // Les groupes viennent de l'identité du serveur, jamais des arguments.
        const chunks = await retrieve(question, { userGroups: user.groupes, k });
        const passages = chunks.map((chunk) => ({
          fichier: chunk.fileName,
          pages: range(chunk.pageStart, chunk.pageEnd),
          extrait: chunk.content,
          score: Math.round(chunk.score * 1000) / 1000,
        }));

        // Aucun passage n'est pas une erreur : c'est une réponse (« rien de pertinent pour toi »).
        const text =
          passages.length === 0
            ? "Aucun passage trouvé dans les documents accessibles à cet utilisateur."
            : chunks
                .map((chunk, i) => `[${i + 1}] ${chunk.fileName}, ${formatPages(chunk)} (score ${passages[i]!.score})\n${chunk.content}`)
                .join("\n\n");
        // content : le texte que lit le modèle. structuredContent : les mêmes
        // données, typées par outputSchema, pour un client qui les traite.
        return { content: [{ type: "text", text }], structuredContent: { passages } };
      }),
  );
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
