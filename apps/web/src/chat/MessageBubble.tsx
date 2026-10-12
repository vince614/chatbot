import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ToolActivityLine } from "./ToolActivityLine";
import type { UiMessage } from "./types";

interface MessageBubbleProps {
  message: UiMessage;
  /** Vrai pour la réponse assistant en cours de génération. */
  streaming: boolean;
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <article className={`bubble bubble--${message.role}`}>
      {isUser ? (
        // Le texte utilisateur est affiché tel quel, sauts de ligne compris.
        <p className="bubble__text">{message.content}</p>
      ) : (
        <>
          {message.tools && message.tools.length > 0 && (
            <div className="bubble__tools">
              {message.tools.map((activity, index) => (
                <ToolActivityLine key={index} activity={activity} />
              ))}
            </div>
          )}
          <div className="bubble__markdown">
            {/* Pas de rehype-raw : le HTML éventuel reste du texte échappé. */}
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
            {streaming && <span className="bubble__cursor" aria-hidden="true" />}
          </div>
        </>
      )}
    </article>
  );
}
