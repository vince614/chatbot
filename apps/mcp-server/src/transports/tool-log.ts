import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse, type RequestId } from "@modelcontextprotocol/sdk/types.js";

/** Ce qu'on journalise d'un appel d'outil : jamais ses arguments ni son résultat. */
export interface ToolCallRecord {
  tool: string;
  durationMs: number;
  ok: boolean;
}

/**
 * Observe les appels d'outils qui passent par ce transport, sans toucher aux
 * outils : la requête tools/call entre (onmessage), sa réponse sort (send).
 * L'identifiant JSON-RPC relie les deux.
 *
 * À appeler APRÈS server.connect(transport) : c'est connect() qui installe
 * onmessage, qu'on enveloppe ici.
 */
export function observeToolCalls(transport: Transport, onDone: (record: ToolCallRecord) => void): void {
  const pending = new Map<RequestId, { tool: string; startedAt: number }>();

  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (isJSONRPCRequest(message) && message.method === "tools/call") {
      const name = message.params?.["name"];
      pending.set(message.id, { tool: typeof name === "string" ? name : "?", startedAt: performance.now() });
    }
    receive?.(message, extra);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const call = message.id === undefined ? undefined : pending.get(message.id);
      if (call && message.id !== undefined) {
        pending.delete(message.id);
        // Un outil en échec renvoie un résultat isError ; une erreur JSON-RPC
        // (arguments refusés par le SDK, outil inconnu) n'a pas de résultat.
        const ok = isJSONRPCResultResponse(message) && message.result["isError"] !== true;
        onDone({ tool: call.tool, durationMs: Math.round(performance.now() - call.startedAt), ok });
      }
    }
    return send(message, options);
  };
}
