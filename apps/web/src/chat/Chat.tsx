import { useState, type CSSProperties } from "react";

import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { EventLogPanel, type LogPlacement } from "./EventLogPanel";
import { MessageList } from "./MessageList";
import { ResizeHandle } from "./ResizeHandle";
import { useChat } from "./useChat";
import "./chat.css";

export function Chat() {
  const { messages, status, error, send, stop, retry, log, clearLog } = useChat();
  const [placement, setPlacement] = useState<LogPlacement>(readPlacement);
  const [logWidth, setLogWidth] = useState(() => readSize(WIDTH_KEY, DEFAULT_WIDTH));
  const [logHeight, setLogHeight] = useState(() => readSize(HEIGHT_KEY, DEFAULT_HEIGHT));

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
      <div className="chat">
        <header className="chat__header">
          <div>
            <h1>Chatbot</h1>
            <p className="chat__subtitle">Streaming, outils et journal en direct</p>
          </div>
          <span className={`status status--${status}`}>
            <span className="status__dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
        </header>

        <MessageList messages={messages} status={status} />

        {status === "error" && error && <ErrorBanner message={error} onRetry={retry} />}

        <Composer disabled={status === "streaming"} onSend={send} onStop={stop} />
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
