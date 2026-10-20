import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import type { ToolPolicy } from "../tools/index.js";
import type { McpPool } from "./pool.js";

/**
 * Préfixe des outils de notre serveur MCP : « mcp__<serveur>__<outil> », la
 * convention de Claude Code. Un outil maison ne peut donc jamais porter le
 * même nom qu'un outil MCP, et le nom dit d'où vient l'outil.
 */
export const MCP_TOOL_PREFIX = "mcp__rag__";

/**
 * Délai d'un outil MCP. Une recherche, c'est un embedding chez Voyage puis
 * une requête SQL, plus le démarrage du serveur au premier appel (environ
 * 1 s) : les 5 s des outils maison ne suffisent pas toujours.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Ce que le modèle lit quand le serveur MCP ne répond pas. Rien de technique : pas de pid, pas de pile. */
export const UNAVAILABLE_MESSAGE =
  "La recherche dans les documents est indisponible pour le moment (serveur arrêté). Dis-le à l'utilisateur " +
  "et invite-le à réessayer dans un instant ; ne réponds pas de mémoire à une question sur les documents.";

/**
 * Réécrit le résultat réussi d'un outil avant qu'il parte au modèle.
 * toolName est le nom côté serveur (sans préfixe). Renvoyer undefined garde
 * le texte du serveur.
 */
export type FormatMcpResult = (toolName: string, result: CallToolResult) => string | undefined;

export interface LoadMcpToolsOptions {
  formatResult?: FormatMcpResult;
  /** Délai de chaque outil ; l'évaluation l'allonge pour attendre le quota de Voyage. */
  timeoutMs?: number;
}

export interface McpToolset {
  tools: StructuredToolInterface[];
  /** false : le serveur n'a pas répondu, les outils renvoient tous UNAVAILABLE_MESSAGE. */
  available: boolean;
}

/**
 * Les derniers outils annoncés par un serveur MCP. Ils sont les mêmes pour
 * tous les utilisateurs (les descriptions ne nomment aucun document) : on
 * peut les présenter à n'importe qui quand son serveur ne répond pas.
 */
let lastKnownTools: McpTool[] | null = null;

/**
 * Si aucun serveur n'a jamais répondu depuis le démarrage de l'API : de quoi
 * garder la recherche dans la liste, pour que le modèle l'appelle sur une
 * question documentaire et apprenne ainsi qu'elle est indisponible.
 */
const FALLBACK_TOOLS: McpTool[] = [
  {
    name: "search_documents",
    description:
      "Cherche dans les documents internes de l'entreprise les passages pertinents pour une question. " +
      "À utiliser pour toute question sur le contenu de ces documents.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "La question, en langage naturel." } },
      required: ["question"],
    },
    annotations: { readOnlyHint: true },
  },
];

/**
 * Les outils du serveur MCP de cet utilisateur, en outils LangChain.
 * Démarre son serveur s'il ne tourne pas encore.
 */
export async function loadMcpTools(
  pool: McpPool,
  userId: string,
  options: LoadMcpToolsOptions = {},
): Promise<StructuredToolInterface[]> {
  const tools = await pool.listTools(userId);
  lastKnownTools = tools;
  return tools.map((mcpTool) => toLangChainTool(pool, userId, mcpTool, options));
}

/**
 * Comme loadMcpTools, mais ne lève jamais : si le serveur ne répond pas, les
 * mêmes outils sont déclarés et répondent tous « indisponible ». Le modèle
 * garde ainsi la recherche dans sa liste, l'appelle pour une question sur
 * les documents, et c'est ce résultat d'outil qui le prévient.
 */
export async function loadMcpToolsOrFallback(
  pool: McpPool,
  userId: string,
  options: LoadMcpToolsOptions = {},
): Promise<McpToolset> {
  try {
    return { tools: await loadMcpTools(pool, userId, options), available: true };
  } catch {
    // La cause est déjà dans les logs du pool (démarrage raté, disjoncteur).
    const tools = (lastKnownTools ?? FALLBACK_TOOLS).map((mcpTool) =>
      tool(
        async () => {
          throw new Error(UNAVAILABLE_MESSAGE);
        },
        describe(mcpTool, DEFAULT_TIMEOUT_MS),
      ),
    );
    return { tools, available: false };
  }
}

/**
 * Un outil MCP vu par LangChain : `tool()` accepte directement le JSON Schema
 * annoncé par le serveur. Une erreur levée ici devient, grâce au garde
 * (tools/guard.ts), un résultat d'outil en échec que le modèle lit.
 */
function toLangChainTool(pool: McpPool, userId: string, mcpTool: McpTool, options: LoadMcpToolsOptions): StructuredToolInterface {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return tool(async (input, config) => {
    // Le signal de la requête (client parti) et le délai de l'outil : le SDK
    // envoie au serveur une annulation au lieu d'attendre la réponse.
    const signal = AbortSignal.any([config?.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
    let result: CallToolResult;
    try {
      // Le serveur reçoit son nom à lui, sans le préfixe.
      result = await pool.callTool(userId, mcpTool.name, input, signal);
    } catch (error) {
      if (config?.signal?.aborted) throw error;
      if (signal.aborted) throw new Error(`L'outil "${MCP_TOOL_PREFIX}${mcpTool.name}" a dépassé le délai de ${timeoutMs} ms.`);
      // Serveur tombé pendant l'appel, ou disjoncteur ouvert.
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    if (result.isError) throw new Error(textOf(result));
    return options.formatResult?.(mcpTool.name, result) ?? textOf(result);
  }, describe(mcpTool, timeoutMs));
}

/** Nom préfixé, description, schéma ; et, pour le garde, s'il ne fait que lire et son délai. */
function describe(mcpTool: McpTool, timeoutMs: number) {
  const policy: ToolPolicy = {
    // L'annotation du serveur, et seulement si elle est explicite : un outil
    // muet sur ce point est traité comme une action (confirmation requise).
    readOnly: mcpTool.annotations?.readOnlyHint === true,
    // Le garde ajoute une seconde de marge : c'est le signal ci-dessus qui doit couper le premier.
    timeoutMs: timeoutMs + 1_000,
  };
  return {
    name: `${MCP_TOOL_PREFIX}${mcpTool.name}`,
    description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
    // Le schéma est déjà du JSON Schema : LangChain le transmet tel quel au modèle.
    schema: withoutMetaSchema(mcpTool.inputSchema),
    metadata: { ...policy },
  };
}

/** Le "$schema" n'apporte rien au modèle. */
function withoutMetaSchema(schema: McpTool["inputSchema"]): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/** Le texte que le serveur destine au modèle : ses blocs texte, mis bout à bout. */
function textOf(result: CallToolResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
}
