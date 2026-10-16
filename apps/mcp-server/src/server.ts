import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerListDocuments } from "./tools/list-documents.js";
import { registerSearchDocuments } from "./tools/search-documents.js";
import type { ToolContext } from "./tools/shared.js";

/**
 * Le serveur MCP et ses outils, pour un utilisateur. Il ne sait rien du
 * transport : stdio et HTTP le branchent chacun à leur façon, avec
 * server.connect(transport).
 *
 * L'utilisateur est dans le contexte des outils, pas dans leurs arguments :
 * le modèle ne peut pas le changer.
 */
export function createRagServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "chatbot-rag", version: "0.1.0" });
  registerSearchDocuments(server, context);
  registerListDocuments(server, context);
  return server;
}
