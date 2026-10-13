import { sourceAnchorId, formatPages } from "./citations";
import type { Source } from "./types";

interface SourceListProps {
  /** Uniquement les sources citées dans le texte, déjà triées par numéro. */
  sources: Source[];
  /** Id unique du message, pour que les ancres ne collisionnent pas entre bulles. */
  messageId: string;
  /** Numéros des sources dépliées : l'état vit dans la bulle pour qu'une citation puisse en ouvrir une. */
  openIndexes: ReadonlySet<number>;
  onToggle: (index: number) => void;
}

/** Les sources citées sous une réponse, une par `<details>` contrôlé. */
export function SourceList({ sources, messageId, openIndexes, onToggle }: SourceListProps) {
  return (
    <section className="sources" aria-label="Sources">
      <h2 className="sources__title">Sources</h2>
      {sources.map((source) => (
        <details
          key={source.index}
          id={sourceAnchorId(messageId, source.index)}
          className="source"
          open={openIndexes.has(source.index)}
        >
          {/* preventDefault : c'est l'état React qui ouvre/ferme, pas le navigateur. */}
          <summary
            className="source__summary"
            onClick={(event) => {
              event.preventDefault();
              onToggle(source.index);
            }}
          >
            <span className="source__file">
              [{source.index}] {source.fileName} — {formatPages(source)}
            </span>
          </summary>
          <blockquote className="source__excerpt">{source.excerpt}</blockquote>
          <p className="source__score">similarité {source.score.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </details>
      ))}
    </section>
  );
}
