import { useCallback, useRef, useState } from "react";

import { streamChat } from "./api";
import type { ChatMessage, ChatStatus, LogEntry, UiMessage } from "./types";

export interface UseChatResult {
  messages: UiMessage[];
  status: ChatStatus;
  error: string | null;
  /** Ajoute un message utilisateur et lance la génération. */
  send: (text: string) => void;
  /** Interrompt la génération en cours, en gardant le texte déjà reçu. */
  stop: () => void;
  /** Après une erreur : retire la réponse incomplète et renvoie le dernier message utilisateur. */
  retry: () => void;
  /** Journal des événements, du plus ancien au plus récent. */
  log: LogEntry[];
  clearLog: () => void;
}

/** Au-delà, les plus anciennes lignes du journal sont oubliées. */
const MAX_LOG_ENTRIES = 300;
/** Garde-fou sur le texte libre d'une ligne ; les données structurées ne sont pas tronquées. */
const MAX_LOG_MESSAGE = 4_000;

/**
 * Porte tout l'état du chat. L'historique vit uniquement dans l'état React :
 * recharger la page repart de zéro, c'est voulu.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextLogId = useRef(1);

  const append = useCallback((kind: LogEntry["kind"], message: string, data?: unknown) => {
    const entry: LogEntry = {
      id: nextLogId.current++,
      time: new Date().toLocaleTimeString("fr-FR", { hour12: false }) + "." + String(Date.now() % 1000).padStart(3, "0"),
      kind,
      message: message.length > MAX_LOG_MESSAGE ? `${message.slice(0, MAX_LOG_MESSAGE - 1)}…` : message,
      ...(data !== undefined && { data }),
    };
    setLog((prev) => (prev.length >= MAX_LOG_ENTRIES ? [...prev.slice(1), entry] : [...prev, entry]));
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  const run = useCallback(async (history: UiMessage[]) => {
    const controller = new AbortController();
    abortRef.current = controller;

    // Bulle assistant vide, remplie au fil des deltas.
    setMessages([...history, { role: "assistant", content: "" }]);
    setStatus("streaming");
    setError(null);
    append("state", "status → streaming");

    const wire = toWireHistory(history);
    append("send", `POST /api/chat avec ${wire.length} message(s), ${JSON.stringify(wire).length} octets`);

    try {
      await streamChat(wire, controller.signal, {
        onHttp: (code) => append("http", `réponse HTTP ${code}`),
        // Les événements "debug" ont leur propre ligne, plus lisible, via onDebug.
        onEvent: (event, data) => {
          if (event !== "debug") append("sse", event, parseJsonOrText(data));
        },
        onDebug: (kind, turn, payload) => {
          const arrow = kind === "model_request" ? "→ envoyé au modèle" : "← reçu du modèle";
          append("model", `${arrow} (tour ${turn})`, payload);
        },
        onDelta: (text) => setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, content: m.content + text }))),
        onToolCall: (name, input) =>
          setMessages((prev) =>
            updateLastAssistant(prev, (m) => ({ ...m, tools: [...(m.tools ?? []), { name, input }] })),
          ),
        onToolResult: (name, ok) =>
          setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, tools: markToolResult(m.tools, name, ok) }))),
      });
      setStatus("idle");
      append("state", "status → idle (réponse complète)");
    } catch (err) {
      setMessages(dropEmptyTrailingAssistant);
      if (controller.signal.aborted) {
        // Arrêt volontaire : pas une erreur.
        setStatus("idle");
        append("state", "status → idle (arrêt volontaire)");
      } else {
        const message = err instanceof Error ? err.message : "Erreur inconnue.";
        setError(message);
        setStatus("error");
        append("state", `status → error : ${message}`);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [append]);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || status === "streaming") return;
      append("action", `send (${content.length} caractères)`);
      void run([...messages, { role: "user", content }]);
    },
    [messages, status, run, append],
  );

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    append("action", "stop : AbortController.abort()");
    abortRef.current.abort();
  }, [append]);

  const retry = useCallback(() => {
    if (status === "streaming") return;
    const history = trimToLastUserMessage(messages);
    if (history.length === 0) return;
    append("action", "retry : renvoi jusqu'au dernier message utilisateur");
    void run(history);
  }, [messages, status, run, append]);

  return { messages, status, error, send, stop, retry, log, clearLog };
}

/** Le champ data d'un événement SSE est du JSON chez nous, mais on reste tolérant. */
function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Projette l'historique en texte seul avant l'envoi.
 *
 * SIMPLIFICATION VOULUE : les appels d'outils et leurs résultats ne vivent que
 * le temps d'une requête, côté serveur. Au message suivant, le modèle ne voit
 * que sa réponse textuelle finale, pas les résultats bruts des outils. Pour
 * une question de suivi (« et en secondes ? »), il rappellera l'outil.
 */
function toWireHistory(messages: UiMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

function updateLastAssistant(
  messages: UiMessage[],
  update: (message: UiMessage) => UiMessage,
): UiMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), update(last)];
}

/** Marque comme terminé le premier appel encore en cours portant ce nom. */
function markToolResult(tools: UiMessage["tools"], name: string, ok: boolean) {
  if (!tools) return tools;
  const index = tools.findIndex((tool) => tool.name === name && tool.ok === undefined);
  if (index === -1) return tools;
  return tools.map((tool, i) => (i === index ? { ...tool, ok } : tool));
}

/** Après Stop ou erreur : une bulle sans texte ni outil n'a rien à montrer. */
function dropEmptyTrailingAssistant(messages: UiMessage[]): UiMessage[] {
  const last = messages.at(-1);
  const isEmpty = last?.role === "assistant" && last.content === "" && !last.tools?.length;
  return isEmpty ? messages.slice(0, -1) : messages;
}

/** Retire les réponses assistant finales pour que l'historique se termine par un message user. */
function trimToLastUserMessage(messages: UiMessage[]): UiMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "assistant") end -= 1;
  return messages.slice(0, end);
}
