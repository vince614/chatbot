import type { Attachment } from "../chat/types";

interface AttachmentChipsProps {
  items: readonly Attachment[];
  /** Absent : lecture seule (bulle d'un message déjà envoyé), sans bouton ×. */
  onRemove?: (uri: string) => void;
}

/** Les pièces jointes en pastilles : au-dessus de la saisie, ou dans la bulle d'un message envoyé. */
export function AttachmentChips({ items, onRemove }: AttachmentChipsProps) {
  if (items.length === 0) return null;
  return (
    <ul className={`chips${onRemove ? "" : " chips--readonly"}`} aria-label="Pièces jointes">
      {items.map((item) => (
        <li key={item.uri} className="chip-attachment" title={item.uri}>
          <span aria-hidden="true">📎</span>
          <span className="chip-attachment__name">{item.name}</span>
          {onRemove && (
            <button
              type="button"
              className="chip-attachment__remove"
              onClick={() => onRemove(item.uri)}
              aria-label={`Retirer ${item.name}`}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
