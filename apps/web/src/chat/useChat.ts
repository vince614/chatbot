import { useCallback, useEffect, useRef, useState } from "react";

import { type Autosave, createAutosave } from "../storage/autosave";
import type { Conversation } from "../storage/types";
import { ChatError, streamChat } from "./api";
import type { ChatMessage, ChatStatus, LogEntry, SendInput, UiMessage } from "./types";

export interface UseChatResult {
  messages: UiMessage[];
  status: ChatStatus;
  error: string | null;
  /** Ajoute un message utilisateur (texte, pièces jointes ou prompt) et lance la génération. */
  send: (input: SendInput) => void;
  /** Interrompt la génération en cours, en gardant le texte déjà reçu. */
  stop: () => void;
  /** Après une erreur : retire la réponse incomplète et renvoie le dernier message utilisateur. */
  /** Faux quand la dernière requête a été refusée (400) : pas de bouton « Réessayer ». */
  canRetry: boolean;
  retry: () => void;
  /** Journal des événements, du plus ancien au plus récent. */
  log: LogEntry[];
  clearLog: () => void;
  /**
   * Avant de supprimer la conversation courante ou de tout effacer : arrête
   * le flux et oublie la sauvegarde en attente, sinon elle réécrirait ce
   * qu'on vient de supprimer.
   */
  discardPending: () => Promise<void>;
  /** Attend que la sauvegarde en attente soit écrite (avant de rouvrir une conversation depuis le disque). */
  flushPending: () => Promise<void>;
}

/** Au-delà, les plus anciennes lignes du journal sont oubliées. */
const MAX_LOG_ENTRIES = 300;
/** Garde-fou sur le texte libre d'une ligne ; les données structurées ne sont pas tronquées. */
const MAX_LOG_MESSAGE = 4_000;
/** Pendant le streaming : au plus une sauvegarde chiffrée toutes les 2 s, pas une par delta. */
const SAVE_DELAY_MS = 2_000;

/**
 * Porte tout l'état du chat de la conversation `conversation`, qu'il charge
 * quand elle change et qu'il sauvegarde (chiffrée, dans ce navigateur) :
 * différé pendant le streaming, tout de suite quand la réponse se termine.
 * Le serveur, lui, ne reçoit que les messages de cette conversation, le temps
 * de la requête.
 * `userId` est l'identité envoyée au serveur ; vide tant qu'aucun utilisateur n'est choisi.
 */
export function useChat(
  userId: string,
  conversation: Conversation | null,
  onSaved: (saved: Conversation) => void,
): UseChatResult {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Faux après un refus (400) : renvoyer la même requête serait refusé de la même façon.
  const [canRetry, setCanRetry] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextLogId = useRef(1);
  // Les messages et la conversation aussi en ref : la sauvegarde a besoin de
  // leur dernière valeur à l'instant où elle est demandée, sans attendre un rendu.
  const messagesRef = useRef<UiMessage[]>([]);
  const conversationRef = useRef<Conversation | null>(null);
  const onSavedRef = useRef(onSaved);
  const autosaveRef = useRef<Autosave | null>(null);

  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  /** Met à jour les messages : la ref tout de suite, l'état pour l'affichage. */
  const commit = useCallback((next: UiMessage[] | ((prev: UiMessage[]) => UiMessage[])) => {
    const value = typeof next === "function" ? next(messagesRef.current) : next;
    messagesRef.current = value;
    setMessages(value);
  }, []);

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

  autosaveRef.current ??= createAutosave({
    delayMs: SAVE_DELAY_MS,
    onSaved: (saved, durationMs) => {
      if (conversationRef.current?.id === saved.id) conversationRef.current = saved;
      append("state", `sauvegarde chiffrée : ${saved.messages.length} message(s) en ${durationMs} ms`);
      onSavedRef.current(saved);
    },
    onError: (err) => append("state", `sauvegarde impossible : ${err instanceof Error ? err.message : String(err)}`),
  });

  /** Demande une sauvegarde différée de la conversation courante, avec ses messages actuels. */
  const scheduleSave = useCallback(() => {
    const current = conversationRef.current;
    if (current) autosaveRef.current?.schedule({ conversation: current, messages: messagesRef.current });
  }, []);

  // Changement de conversation (sélection, nouvelle, autre utilisateur) : on
  // quitte la précédente (son flux est arrêté, ce qu'elle a de non sauvegardé
  // est écrit), puis on affiche celle-ci. Changer d'utilisateur passe aussi
  // par ici : l'historique de l'utilisateur précédent, et ses sources, ne
  // restent ni à l'écran ni dans ce qui part au serveur (fuite par l'historique).
  const conversationId = conversation?.id ?? null;
  useEffect(() => {
    const autosave = autosaveRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      scheduleSave();
    }
    void autosave?.flush();
    conversationRef.current = conversation;
    commit(conversation?.messages ?? []);
    setStatus("idle");
    setError(null);
    if (conversation) {
      append("state", `conversation ouverte : ${conversation.messages.length} message(s)${conversation.messages.length ? " (déchiffrée)" : ", neuve"}`);
    }
    // Seul l'identifiant compte : la même conversation réenregistrée (titre,
    // date) ne doit pas recharger ses messages pendant qu'on l'écrit.
  }, [conversationId]);

  // Onglet masqué, fermé ou rechargé : on écrit tout de suite ce qui attend,
  // sans attendre les 2 s du délai. « hidden » arrive aussi avant une
  // fermeture, et laisse plus de chances que pagehide de finir l'écriture.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (abortRef.current) scheduleSave();
      void autosaveRef.current?.flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      // Démontage : le flux en cours n'a plus personne à qui parler.
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const run = useCallback(async (history: UiMessage[]) => {
    // Garde-fou : jamais l'historique d'une conversation au nom d'un autre utilisateur.
    if (!userId || conversationRef.current?.userId !== userId) return;
    const controller = new AbortController();
    abortRef.current = controller;

    // Bulle assistant vide, remplie au fil des deltas. Le message utilisateur
    // est sauvegardé dès maintenant (différé), même si la réponse échoue.
    commit([...history, { role: "assistant", content: "" }]);
    scheduleSave();
    setStatus("streaming");
    setError(null);
    setCanRetry(true);
    append("state", "status → streaming");

    // Un flux annulé (Stop, changement d'utilisateur) ne doit plus toucher aux messages,
    // même si des événements déjà lus restent à traiter.
    const updateAssistant = (update: (message: UiMessage) => UiMessage) => {
      if (controller.signal.aborted) return;
      commit((prev) => updateLastAssistant(prev, update));
      scheduleSave();
    };

    const wire = toWireHistory(history);
    append("send", `POST /api/chat avec ${wire.length} message(s), ${JSON.stringify(wire).length} octets`);

    try {
      await streamChat(wire, userId, controller.signal, {
        onHttp: (code) => append("http", `réponse HTTP ${code}`),
        // Les événements "debug" ont leur propre ligne, plus lisible, via onDebug.
        onEvent: (event, data) => {
          if (event !== "debug") append("sse", event, parseJsonOrText(data));
        },
        onDebug: (kind, turn, payload) => {
          const arrow = kind === "model_request" ? "→ envoyé au modèle" : "← reçu du modèle";
          append("model", `${arrow} (tour ${turn})`, payload);
        },
        onDelta: (text) => updateAssistant((m) => ({ ...m, content: m.content + text })),
        onSources: (sources) => updateAssistant((m) => ({ ...m, sources })),
        onToolCall: (name, input) => updateAssistant((m) => ({ ...m, tools: [...(m.tools ?? []), { name, input }] })),
        onToolResult: (name, ok) => updateAssistant((m) => ({ ...m, tools: markToolResult(m.tools, name, ok) })),
      });
      setStatus("idle");
      append("state", "status → idle (réponse complète)");
    } catch (err) {
      // Flux remplacé par reset() : l'état appartient déjà à la conversation suivante.
      if (abortRef.current !== controller) return;
      commit(dropEmptyTrailingAssistant);
      if (controller.signal.aborted) {
        // Arrêt volontaire : pas une erreur.
        setStatus("idle");
        append("state", "status → idle (arrêt volontaire)");
      } else {
        const message = err instanceof Error ? err.message : "Erreur inconnue.";
        // Refusée (400 : document introuvable, prompt inconnu…) : la requête n'a
        // pas été traitée. Le message part de l'historique, sinon il serait
        // renvoyé, et refusé, avec chaque message suivant.
        const refused = err instanceof ChatError && err.status === 400;
        if (refused) commit(dropTrailingUserMessage);
        setCanRetry(!refused);
        setError(message);
        setStatus("error");
        append("state", `status → error : ${message}`);
      }
    } finally {
      // Réponse terminée, arrêtée ou en erreur : on écrit tout de suite. Sauf
      // si la conversation a été quittée (ou supprimée) entre-temps : c'est
      // l'effet de changement de conversation, ou discardPending, qui décide.
      if (abortRef.current === controller) {
        abortRef.current = null;
        scheduleSave();
        void autosaveRef.current?.flush();
      }
    }
  }, [append, commit, scheduleSave, userId]);

  const send = useCallback(
    ({ text, attachments, prompt }: SendInput) => {
      const content = text.trim();
      // abortRef plutôt que status : deux envois dans le même rendu verraient
      // encore « idle » et lanceraient deux flux, dont un impossible à arrêter.
      if (!content || !userId || abortRef.current) return;
      const extras = [prompt && `prompt ${prompt.name}`, attachments?.length && `${attachments.length} pièce(s) jointe(s)`]
        .filter(Boolean)
        .join(", ");
      append("action", `send (${content.length} caractères${extras ? `, ${extras}` : ""})`);
      const message: UiMessage = {
        role: "user",
        content,
        ...(attachments?.length && { attachments }),
        ...(prompt && { prompt }),
      };
      void run([...messagesRef.current, message]);
    },
    [userId, run, append],
  );

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    append("action", "stop : AbortController.abort()");
    abortRef.current.abort();
  }, [append]);

  const retry = useCallback(() => {
    if (status === "streaming" || !userId) return;
    const history = trimToLastUserMessage(messages);
    if (history.length === 0) return;
    append("action", "retry : renvoi jusqu'au dernier message utilisateur");
    void run(history);
  }, [messages, status, userId, run, append]);

  const discardPending = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      // Le catch de run ne s'en charge pas (le flux n'est plus le sien) :
      // sans cela, l'interface resterait « en génération » si la suppression échoue.
      commit(dropEmptyTrailingAssistant);
      setStatus("idle");
    }
    await autosaveRef.current?.discard();
  }, [commit]);

  const flushPending = useCallback(async () => {
    await autosaveRef.current?.flush();
  }, []);

  return { messages, status, error, canRetry, send, stop, retry, log, clearLog, discardPending, flushPending };
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
 * Projette l'historique avant l'envoi : `role` et `content`, plus les URI des
 * pièces jointes et le prompt des messages utilisateur. Le serveur les
 * re-résout à CHAQUE requête pour TOUT l'historique (il ne garde rien), donc
 * chaque message doit les redonner. Les sources (comme les outils) ne sont
 * qu'un affichage et ne repartent jamais ; les [n] restent dans le texte, mais
 * le serveur re-récupère ses propres passages à chaque question.
 *
 * SIMPLIFICATION VOULUE : les appels d'outils et leurs résultats ne vivent que
 * le temps d'une requête, côté serveur. Au message suivant, le modèle ne voit
 * que sa réponse textuelle finale, pas les résultats bruts des outils. Pour
 * une question de suivi (« et en secondes ? »), il rappellera l'outil.
 */
function toWireHistory(messages: UiMessage[]): ChatMessage[] {
  return messages.map(({ role, content, attachments, prompt }) => ({
    role,
    content,
    ...(attachments?.length && { attachments: attachments.map((attachment) => attachment.uri) }),
    ...(prompt && { prompt }),
  }));
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

/**
 * Après Stop ou erreur : une bulle sans texte ni outil n'a rien à montrer.
 * Des sources seules ne comptent pas : elles ne s'affichent que si le texte
 * les cite, donc sans texte elles restent invisibles.
 */
/** Retire le dernier message s'il vient de l'utilisateur (sa requête a été refusée). */
function dropTrailingUserMessage(messages: UiMessage[]): UiMessage[] {
  return messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
}

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
