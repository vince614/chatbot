import type { ServerResponse } from "node:http";

/** Les événements que le flux /api/chat peut émettre. */
export type SseEvent =
  | { event: "delta"; data: { text: string } }
  /** Le modèle demande un outil ; émis juste avant son exécution. */
  | { event: "tool_call"; data: { name: string; input: unknown } }
  /** L'outil a répondu. Le contenu du résultat reste côté serveur. */
  | { event: "tool_result"; data: { name: string; ok: boolean } }
  | { event: "done"; data: Record<string, never> }
  | { event: "error"; data: { message: string } };

export function formatSseEvent({ event, data }: SseEvent): string {
  // JSON.stringify ne produit jamais de saut de ligne brut : la ligne "data:" reste entière.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Ouvre un flux Server-Sent Events sur la réponse HTTP brute et renvoie
 * deux fonctions sûres : écrire un événement, fermer le flux. Les écritures
 * après déconnexion du client sont ignorées.
 */
export function openSseStream(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Évite la mise en tampon par un reverse proxy (nginx) le jour où il y en a un.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const isWritable = () => !res.destroyed && !res.writableEnded;

  return {
    send(event: SseEvent): void {
      if (isWritable()) res.write(formatSseEvent(event));
    },
    close(): void {
      if (isWritable()) res.end();
    },
  };
}
