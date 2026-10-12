import { createSseParser } from "./sse";
import type { ChatMessage } from "./types";

/** Erreur "métier" du chat, dont le message peut être affiché tel quel. */
export class ChatError extends Error {
  override readonly name = "ChatError";
}

export interface StreamChatHandlers {
  /** Un fragment de la réponse textuelle. */
  onDelta: (text: string) => void;
  /** Le serveur va exécuter un outil. */
  onToolCall: (name: string, input: unknown) => void;
  /** L'outil a répondu, avec ou sans succès. */
  onToolResult: (name: string, ok: boolean) => void;
}

/**
 * Envoie l'historique complet à POST /api/chat et appelle les handlers pour
 * chaque événement reçu. Se résout quand le serveur émet "done".
 * Rejette avec ChatError (HTTP non 2xx, événement "error", flux tronqué) ou
 * avec l'erreur du fetch (réseau, AbortError).
 */
export async function streamChat(
  messages: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamChatHandlers,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!response.ok) {
    throw new ChatError(await describeHttpError(response));
  }
  if (!response.body) {
    throw new ChatError("Le serveur a répondu sans corps.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let completed = false;

  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;

      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        switch (event.event) {
          case "delta":
            handlers.onDelta(parseJson<{ text: string }>(event.data).text);
            break;
          case "tool_call": {
            const { name, input } = parseJson<{ name: string; input: unknown }>(event.data);
            handlers.onToolCall(name, input);
            break;
          }
          case "tool_result": {
            const { name, ok } = parseJson<{ name: string; ok: boolean }>(event.data);
            handlers.onToolResult(name, ok);
            break;
          }
          case "done":
            completed = true;
            break;
          case "error":
            throw new ChatError(parseJson<{ message: string }>(event.data).message);
        }
      }
    }
  } finally {
    // Libère la connexion si on sort avant la fin (erreur, abort).
    await reader.cancel().catch(() => undefined);
  }

  if (!completed) {
    throw new ChatError("La connexion s'est interrompue avant la fin de la réponse.");
  }
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function describeHttpError(response: Response): Promise<string> {
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      issues?: { message: string }[];
    } | null;
    const detail = body?.issues?.[0]?.message;
    return detail ? `Requête refusée : ${detail}` : "Requête refusée par le serveur.";
  }
  return `Erreur du serveur (HTTP ${response.status}).`;
}
