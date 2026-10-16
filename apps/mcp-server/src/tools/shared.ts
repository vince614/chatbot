import type { createPool } from "@chatbot/rag/db/pool";
import type { Retrieve } from "@chatbot/rag/retrieve";
import type { User } from "@chatbot/rag/users";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { log } from "../log.js";

/** Ce dont les outils ont besoin, fixé au démarrage. L'utilisateur en fait partie : aucun outil ne le reçoit en argument. */
export interface ToolContext {
  user: User;
  pool: ReturnType<typeof createPool>;
  retrieve: Retrieve;
}

/**
 * Exécute un outil et transforme toute exception en résultat d'outil
 * isError : le modèle lit le message et peut réagir (reformuler, prévenir
 * l'utilisateur), et le serveur continue de servir les appels suivants.
 *
 * Le détail technique (message de pg ou de Voyage) part sur stderr ; le modèle
 * ne reçoit que `publicMessage`. Les logs ne contiennent ni la question ni
 * les groupes : le nom de l'outil, la durée, l'erreur.
 */
export async function runTool(
  name: string,
  publicMessage: string,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const start = performance.now();
  try {
    const result = await run();
    log(`${name} : ok en ${Math.round(performance.now() - start)} ms`);
    return result;
  } catch (error) {
    log(`${name} : échec en ${Math.round(performance.now() - start)} ms : ${error instanceof Error ? error.message : error}`);
    return { isError: true, content: [{ type: "text", text: publicMessage }] };
  }
}
