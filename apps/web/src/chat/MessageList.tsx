import { useEffect, useRef } from "react";

import { MessageBubble } from "./MessageBubble";
import type { ChatStatus, UiMessage } from "./types";

interface MessageListProps {
  messages: UiMessage[];
  status: ChatStatus;
}

export function MessageList({ messages, status }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Défile vers le bas à chaque changement de l'historique (nouveau message ou delta).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="chat__messages chat__messages--empty">
        <div className="empty">
          <p className="empty__title">Pose une question pour commencer.</p>
          <p className="empty__hint">
            Interroge les documents, par exemple « Combien de jours de télétravail sont autorisés ? ». Les
            outils marchent toujours : « Quel jour serons-nous dans 45 jours ? » ou « Combien font 1234 × 5678 ? ».
          </p>
        </div>
      </div>
    );
  }

  const lastIndex = messages.length - 1;

  return (
    <div className="chat__messages">
      {messages.map((message, index) => (
        <MessageBubble
          key={index}
          message={message}
          streaming={status === "streaming" && index === lastIndex}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
