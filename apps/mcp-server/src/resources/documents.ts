import { listVisibleDocuments, readVisibleDocument, type DocumentPassage } from "@chatbot/rag/db/repository";
import { safeErrorReason } from "@chatbot/rag/errors";
import { formatPages } from "@chatbot/rag/retrieve";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { log } from "../log.js";
import type { ToolContext } from "../tools/shared.js";

/** Le catalogue : une ressource fixe. */
export const CATALOG_URI = "rag://documents";
/** Un document : une ressource par fichier, décrite par un modèle d'URI (RFC 6570). */
const DOCUMENT_TEMPLATE = "rag://documents/{fichier}";

/** Au-delà, la ressource est tronquée : un document entier ne doit pas remplir le contexte du modèle. */
export const MAX_DOCUMENT_CHARS = 40_000;

export function documentUri(fileName: string): string {
  return `${CATALOG_URI}/${encodeURIComponent(fileName)}`;
}

/**
 * Les ressources : des données que le CLIENT choisit de lire (un outil, lui,
 * est appelé par le modèle). Comme pour les outils, la liste et la lecture
 * passent par les groupes de l'utilisateur de la session : bruno ne voit pas
 * qu'un document RH existe, et le lire par son URI échoue comme pour un
 * document inexistant.
 */
export function registerDocumentResources(server: McpServer, context: ToolContext): void {
  const { user, pool } = context;

  server.registerResource(
    "catalogue",
    CATALOG_URI,
    {
      title: "Catalogue des documents",
      description: "La liste des documents que l'utilisateur peut lire, avec leur URI.",
      mimeType: "text/markdown",
    },
    async (uri) =>
      timed("ressource catalogue", user.id, async () => {
        const docs = await listVisibleDocuments(pool, user.groupes);
        const text =
          docs.length === 0
            ? "Aucun document accessible."
            : docs.map((doc) => `- [${doc.fileName}](${documentUri(doc.fileName)}) : ${doc.pages} page(s)`).join("\n");
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      }),
  );

  server.registerResource(
    "document",
    new ResourceTemplate(DOCUMENT_TEMPLATE, {
      // resources/list : un élément par document visible. Le client n'a pas à deviner les noms.
      list: async () => {
        const docs = await listVisibleDocuments(pool, user.groupes);
        return {
          resources: docs.map((doc) => ({
            uri: documentUri(doc.fileName),
            name: doc.fileName,
            title: doc.fileName,
            description: `${doc.pages} page(s), ingéré le ${doc.ingestedAt.toISOString().slice(0, 10)}`,
            mimeType: "text/plain",
          })),
        };
      },
      // completion/complete : les noms de fichiers visibles qui contiennent ce qui est tapé.
      complete: { fichier: (value) => completeFileName(context, value) },
    }),
    {
      title: "Document",
      description: "Le texte d'un document, page par page.",
      mimeType: "text/plain",
    },
    async (uri, variables) =>
      timed("ressource document", user.id, async () => {
        const fileName = decodeVariable(variables["fichier"]);
        const text = await readDocumentText(context, fileName);
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
      }),
  );
}

/**
 * Le texte d'un document visible, ou une erreur « introuvable » (même
 * message pour interdit et inexistant). Partagé avec les prompts.
 */
export async function readDocumentText({ user, pool }: ToolContext, fileName: string): Promise<string> {
  const passages = fileName ? await readVisibleDocument(pool, fileName, user.groupes) : null;
  if (!passages) throw new McpError(ErrorCode.InvalidParams, `Document introuvable : ${fileName}`);
  const text = joinPassages(passages);
  return text.length > MAX_DOCUMENT_CHARS
    ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n[… document tronqué à ${MAX_DOCUMENT_CHARS} caractères]`
    : text;
}

/** Les noms de fichiers visibles qui contiennent `value` (sans tenir compte de la casse), dix au plus. */
export async function completeFileName({ user, pool }: ToolContext, value: string): Promise<string[]> {
  const needle = value.toLowerCase();
  const docs = await listVisibleDocuments(pool, user.groupes);
  return docs.map((doc) => doc.fileName).filter((name) => name.toLowerCase().includes(needle)).slice(0, 10);
}

/**
 * Les passages bout à bout, avec leurs pages. Deux passages voisins se
 * chevauchent (15 % du découpage, voir jour-2-ingestion) : on retire du
 * suivant le début qu'il partage avec le précédent.
 */
function joinPassages(passages: DocumentPassage[]): string {
  let previous = "";
  return passages
    .map((passage) => {
      const content = passage.content.slice(overlap(previous, passage.content));
      previous = passage.content;
      return `[${formatPages(passage)}]\n${content.trim()}`;
    })
    .join("\n\n");
}

/** La longueur du plus long début de `next` qui termine `previous`. */
function overlap(previous: string, next: string): number {
  for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

/** Une variable d'URI arrive encodée (« r%C3%A8glement.pdf ») ; un tableau ({fichier*}) n'est pas attendu. */
function decodeVariable(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** Une ligne de log par lecture (ressource ou prompt) : quoi, pour qui, combien de temps. Jamais le contenu. */
export async function timed<T>(name: string, userId: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await run();
    log(`${name} : ok en ${Math.round(performance.now() - start)} ms (utilisateur ${userId})`);
    return result;
  } catch (error) {
    const ms = Math.round(performance.now() - start);
    if (error instanceof McpError) {
      log(`${name} : refusée en ${ms} ms (utilisateur ${userId})`);
      throw error;
    }
    // Le détail (message de pg) reste dans nos logs, le client lit un message neutre.
    log(`${name} : échec en ${ms} ms (utilisateur ${userId}) : ${safeErrorReason(error)}`);
    throw new McpError(ErrorCode.InternalError, "Lecture impossible (base indisponible). Réessaie plus tard.");
  }
}
