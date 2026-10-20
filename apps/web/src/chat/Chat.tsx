import { useEffect, useState, type CSSProperties } from "react";

import { useMcpCatalog } from "../mcp/useMcpCatalog";
import { ConversationSidebar } from "../storage/ConversationSidebar";
import { useConversations } from "../storage/useConversations";

import { fetchUsers, type ChatUser } from "./api";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { EventLogPanel, type LogPlacement } from "./EventLogPanel";
import { MessageList } from "./MessageList";
import { ResizeHandle } from "./ResizeHandle";
import { useChat } from "./useChat";
import { UserSelect, type UsersState } from "./UserSelect";
import "../mcp/mcp.css";
import "./chat.css";

export function Chat() {
  const [userId, setUserId] = useState("");
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [usersState, setUsersState] = useState<UsersState>("loading");
  const conversations = useConversations(userId);
  // Vrai pendant une suppression ou un effacement : aucun envoi ne doit
  // pouvoir relancer une sauvegarde de la conversation qu'on supprime.
  const [busy, setBusy] = useState(false);
  const { messages, status, error, canRetry, send, stop, retry, log, clearLog, discardPending, flushPending } = useChat(
    userId,
    conversations.current,
    conversations.onSaved,
  );
  const catalog = useMcpCatalog(userId);
  const [placement, setPlacement] = useState<LogPlacement>(readPlacement);
  const [logWidth, setLogWidth] = useState(() => readSize(WIDTH_KEY, DEFAULT_WIDTH));
  const [logHeight, setLogHeight] = useState(() => readSize(HEIGHT_KEY, DEFAULT_HEIGHT));

  useEffect(() => {
    const controller = new AbortController();
    fetchUsers(controller.signal)
      .then((list) => {
        setUsers(list);
        setUsersState("ready");
        // Le dernier choix n'est repris que s'il existe encore dans la liste reçue.
        const remembered = readUserId();
        if (list.some((user) => user.id === remembered)) setUserId(remembered);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsersState("error");
      });
    return () => controller.abort();
  }, []);

  const handleUserChange = (next: string) => {
    if (next === userId) return;
    // Les conversations suivent l'utilisateur : useConversations ouvre la
    // liste du nouveau, et useChat quitte (et sauvegarde) celle de l'ancien.
    setUserId(next);
    writeUserId(next);
  };

  // Supprimer la conversation ouverte, ou tout effacer : la sauvegarde en
  // attente est d'abord oubliée, sinon elle réécrirait ce qu'on supprime.
  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      if (id === conversations.current?.id) await discardPending();
      await conversations.remove(id);
    } finally {
      setBusy(false);
    }
  };

  const handleWipe = async () => {
    setBusy(true);
    try {
      await discardPending();
      await conversations.wipe();
    } finally {
      setBusy(false);
    }
  };

  // Rouvrir une conversation la relit sur le disque : sa dernière sauvegarde
  // doit y être arrivée, sinon on afficherait (puis écraserait) une version plus ancienne.
  const handleSelect = async (id: string) => {
    await flushPending();
    await conversations.select(id);
  };

  const togglePlacement = () => {
    const next: LogPlacement = placement === "side" ? "bottom" : "side";
    setPlacement(next);
    try {
      localStorage.setItem(PLACEMENT_KEY, next);
    } catch {
      // Stockage indisponible (navigation privée…) : on garde juste l'état en mémoire.
    }
  };

  const layoutStyle = { "--log-width": `${logWidth}px`, "--log-height": `${logHeight}px` } as CSSProperties;

  return (
    <div className={`layout layout--${placement}`} style={layoutStyle}>
      <div className="workspace">
        {userId && (
          <ConversationSidebar
            items={conversations.items}
            currentId={conversations.current?.id ?? null}
            currentIsNew={conversations.current !== null && !conversations.items.some((item) => item.id === conversations.current?.id)}
            disabled={busy || status === "streaming" || conversations.status !== "ready"}
            notice={conversations.notice}
            onCreate={conversations.create}
            onSelect={(id) => void handleSelect(id)}
            onDelete={(id) => void handleDelete(id)}
            onWipe={() => void handleWipe()}
          />
        )}
        <div className="chat">
          <header className="chat__header">
            <div>
              <h1>Chatbot</h1>
              <p className="chat__subtitle">Streaming, outils et journal en direct</p>
            </div>
            <div className="chat__header-side">
              <UserSelect users={users} state={usersState} value={userId} onChange={handleUserChange} />
              <span className={`status status--${status}`}>
                <span className="status__dot" aria-hidden="true" />
                {STATUS_LABEL[status]}
              </span>
            </div>
          </header>

          <MessageList messages={messages} status={status} />

          {status === "error" && error && <ErrorBanner message={error} onRetry={canRetry ? retry : undefined} />}

          <Composer
            // Brouillon et pièces jointes ne suivent pas d'un utilisateur à l'autre.
            key={userId}
            userId={userId}
            catalog={catalog}
            disabled={busy || status === "streaming" || !conversations.current}
            onSend={send}
            onStop={stop}
            lockedHint={userId ? undefined : "Choisis un utilisateur pour pouvoir écrire."}
          />
        </div>
      </div>

      {placement === "side" ? (
        <ResizeHandle
          orientation="vertical"
          size={logWidth}
          min={MIN_SIZE}
          max={Math.round(window.innerWidth * 0.75)}
          onChange={setLogWidth}
          onCommit={(size) => writeSize(WIDTH_KEY, size)}
        />
      ) : (
        <ResizeHandle
          orientation="horizontal"
          size={logHeight}
          min={MIN_SIZE}
          max={Math.round(window.innerHeight * 0.75)}
          onChange={setLogHeight}
          onCommit={(size) => writeSize(HEIGHT_KEY, size)}
        />
      )}

      <EventLogPanel entries={log} placement={placement} onClear={clearLog} onTogglePlacement={togglePlacement} />
    </div>
  );
}

const STATUS_LABEL = { idle: "Prêt", streaming: "Génération", error: "Erreur" } as const;

const USER_KEY = "chatbot.userId";
const PLACEMENT_KEY = "chatbot.logPlacement";
const WIDTH_KEY = "chatbot.logWidth";
const HEIGHT_KEY = "chatbot.logHeight";
const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 280;
const MIN_SIZE = 160;

function readSize(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= MIN_SIZE ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeSize(key: string, size: number): void {
  try {
    localStorage.setItem(key, String(Math.round(size)));
  } catch {
    // Stockage indisponible : la taille vaut pour la session seulement.
  }
}

/** Confort par navigateur : la position du journal est mémorisée, rien d'autre. */
function readPlacement(): LogPlacement {
  try {
    return localStorage.getItem(PLACEMENT_KEY) === "bottom" ? "bottom" : "side";
  } catch {
    return "side";
  }
}

/** Confort par navigateur : le dernier utilisateur choisi, revalidé contre la liste du serveur. */
function readUserId(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeUserId(userId: string): void {
  try {
    localStorage.setItem(USER_KEY, userId);
  } catch {
    // Stockage indisponible : le choix vaut pour la session seulement.
  }
}
