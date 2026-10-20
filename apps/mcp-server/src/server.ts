import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDocumentPrompts } from "./prompts/documents.js";
import { registerDocumentResources } from "./resources/documents.js";
import { registerListDocuments } from "./tools/list-documents.js";
import { registerSearchDocuments } from "./tools/search-documents.js";
import type { ToolContext } from "./tools/shared.js";

/**
 * Le serveur MCP et ses trois primitives, pour un utilisateur :
 *  - les outils (tools)         : le MODÈLE décide de les appeler ;
 *  - les ressources (resources) : l'APPLICATION ou l'utilisateur les choisit et les lit ;
 *  - les prompts                : l'UTILISATEUR les choisit (commande « / »).
 *
 * Il ne sait rien du transport : stdio et HTTP le branchent chacun à leur
 * façon, avec server.connect(transport).
 *
 * L'utilisateur est dans le contexte, jamais dans les arguments : ni le
 * modèle ni le client ne peuvent le changer.
 */
export function createRagServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "chatbot-rag", version: "0.1.0" });
  registerSearchDocuments(server, context);
  registerListDocuments(server, context);
  registerDocumentResources(server, context);
  registerDocumentPrompts(server, context);
  return server;
}
