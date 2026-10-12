import { useCallback, useRef, useState } from "react";

import { streamChat } from "./api";
import type { ChatMessage, ChatStatus } from "./types";

export interface UseChatResult {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  /** Ajoute un message utilisateur et lance la génération. */
  send: (text: string) => void;
  /** Interrompt la génération en cours, en gardant le texte déjà reçu. */
  stop: () => void;
  /** Après une erreur : retire la réponse incomplète et renvoie le dernier message utilisateur. */
  retry: () => void;
}

/**
 * Porte tout l'état du chat. L'historique vit uniquement dans l'état React :
 * recharger la page repart de zéro, c'est voulu.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (history: ChatMessage[]) => {
    const controller = new AbortController();
    abortRef.current = controller;

    // Bulle assistant vide, remplie au fil des deltas.
    setMessages([...history, { role: "assistant", content: "" }]);
    setStatus("streaming");
    setError(null);

    try {
      await streamChat(history, controller.signal, (text) => {
        setMessages((prev) => appendToLastAssistant(prev, text));
      });
      setStatus("idle");
    } catch (err) {
      setMessages(dropEmptyTrailingAssistant);
      if (controller.signal.aborted) {
        // Arrêt volontaire : pas une erreur.
        setStatus("idle");
      } else {
        setError(err instanceof Error ? err.message : "Erreur inconnue.");
        setStatus("error");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || status === "streaming") return;
      void run([...messages, { role: "user", content }]);
    },
    [messages, status, run],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(() => {
    if (status === "streaming") return;
    const history = trimToLastUserMessage(messages);
    if (history.length === 0) return;
    void run(history);
  }, [messages, status, run]);

  return { messages, status, error, send, stop, retry };
}

function appendToLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), { ...last, content: last.content + text }];
}

function dropEmptyTrailingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.content === "" ? messages.slice(0, -1) : messages;
}

/** Retire les réponses assistant finales pour que l'historique se termine par un message user. */
function trimToLastUserMessage(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "assistant") end -= 1;
  return messages.slice(0, end);
}
