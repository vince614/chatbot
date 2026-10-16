import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { log } from "../log.js";
import { createRagServer } from "../server.js";
import type { ToolContext } from "../tools/shared.js";

/**
 * Transport stdio : un client, un utilisateur, un processus. Le client lance
 * le serveur, écrit sur son stdin, lit son stdout. À partir d'ici, stdout
 * appartient au protocole.
 *
 * onClientGone : appelé quand le client ferme stdin, sa façon d'arrêter le
 * serveur. Renvoie la fonction qui ferme le serveur MCP.
 */
export async function startStdio(
  context: ToolContext,
  searchMode: string,
  onClientGone: () => void,
): Promise<() => Promise<void>> {
  const server = createRagServer(context);
  await server.connect(new StdioServerTransport());
  // L'identifiant seulement : les groupes n'ont rien à faire dans les logs.
  log(`prêt (stdio, utilisateur ${context.user.id}, recherche ${searchMode})`);

  process.stdin.on("close", onClientGone);
  return () => server.close();
}
