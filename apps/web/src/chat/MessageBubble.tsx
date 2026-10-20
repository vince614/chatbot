import { useCallback, useId, useMemo, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AttachmentChips } from "../mcp/AttachmentChips";
import { extractCitedIndexes, formatPages, linkifyCitations, parseCitationHref, sourceAnchorId } from "./citations";
import { checkImageSrc, checkLinkHref, safeUrlTransform } from "./safeUrls";
import { SourceList } from "./SourceList";
import { ToolActivityLine } from "./ToolActivityLine";
import type { UiMessage } from "./types";

interface MessageBubbleProps {
  message: UiMessage;
  /** Vrai pour la réponse assistant en cours de génération. */
  streaming: boolean;
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  const isUser = message.role === "user";
  // useId contient des ":" : on les retire pour obtenir une ancre sûre dans une URL.
  const messageId = useId().replace(/\W/g, "");
  const [openIndexes, setOpenIndexes] = useState<ReadonlySet<number>>(new Set());

  const { sources } = message;
  // Dérivé du texte à chaque rendu : la liste se construit au fil du streaming.
  const citedSources = useMemo(() => {
    const cited = new Set(extractCitedIndexes(message.content, sources));
    return (sources ?? []).filter((s) => cited.has(s.index)).sort((a, b) => a.index - b.index);
  }, [message.content, sources]);
  const markdown = useMemo(
    () => linkifyCitations(message.content, sources, messageId),
    [message.content, sources, messageId],
  );

  const toggleSource = useCallback((index: number) => {
    setOpenIndexes((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }, []);

  // Clic sur une pastille : déplie la source, puis la fait défiler à l'écran une fois dépliée.
  const openSource = useCallback(
    (index: number) => {
      setOpenIndexes((prev) => new Set(prev).add(index));
      requestAnimationFrame(() => {
        document
          .getElementById(sourceAnchorId(messageId, index))
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    },
    [messageId],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, href, children, ...rest }: ComponentProps<"a"> & { node?: unknown }) => {
        const n = parseCitationHref(href, messageId);
        const source = n === null ? undefined : sources?.find((s) => s.index === n);
        if (n === null || !source) {
          // Lien écrit par le modèle : seulement vers une origine connue (voir safeUrls.ts).
          const verdict = checkLinkHref(href);
          if (!verdict.allowed) {
            return (
              <span className="neutralized" title={`Lien non suivi : ${href ?? ""}`}>
                {children} <span className="neutralized__note">[lien non suivi : {verdict.host}]</span>
              </span>
            );
          }
          return verdict.external ? (
            <a href={verdict.url} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ) : (
            <a href={verdict.url} {...rest}>
              {children}
            </a>
          );
        }
        return (
          <a
            href={href}
            className="citation"
            aria-label={`Source ${n} : ${source.fileName}, ${formatPages(source)}`}
            onClick={(event) => {
              // Pas de changement d'URL : on ne fait qu'ouvrir la source.
              event.preventDefault();
              openSource(n);
            }}
          >
            {children}
          </a>
        );
      },
      // Une image distante est une requête sortante automatique : un canal de
      // fuite sans clic. On ne charge que la même origine et les data: bitmap.
      img: ({ node: _node, src, alt }: ComponentProps<"img"> & { node?: unknown }) => {
        const verdict = checkImageSrc(typeof src === "string" ? src : undefined);
        if (!verdict.allowed) {
          return (
            <span className="neutralized" title={`Image non chargée : ${String(src ?? "")}`}>
              [image bloquée{alt ? ` : ${alt}` : ""} — {verdict.host}]
            </span>
          );
        }
        return <img src={verdict.url} alt={alt ?? ""} referrerPolicy="no-referrer" />;
      },
    }),
    [messageId, sources, openSource],
  );

  return (
    <article className={`bubble bubble--${message.role}`}>
      {isUser ? (
        <>
          {/* Le texte utilisateur est affiché tel quel, sauts de ligne compris. Pour un prompt, c'est son libellé. */}
          <p className={`bubble__text${message.prompt ? " bubble__text--prompt" : ""}`}>
            {message.prompt && <span className="badge">prompt</span>}
            {message.content}
          </p>
          {message.attachments && <AttachmentChips items={message.attachments} />}
        </>
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
            {/* Pas de rehype-raw : le HTML éventuel reste du texte échappé. Les URL passent par safeUrls.ts. */}
            <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrlTransform}>
              {markdown}
            </Markdown>
            {streaming && <span className="bubble__cursor" aria-hidden="true" />}
          </div>
          {citedSources.length > 0 && (
            <SourceList
              sources={citedSources}
              messageId={messageId}
              openIndexes={openIndexes}
              onToggle={toggleSource}
            />
          )}
        </>
      )}
    </article>
  );
}
