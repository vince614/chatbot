import { useState } from "react";

import type { ConversationListItem } from "./types";
import "./conversations.css";

interface ConversationSidebarProps {
  items: ConversationListItem[];
  currentId: string | null;
  /** Vrai tant que la conversation ouverte n'a pas été écrite (aucun message). */
  currentIsNew: boolean;
  disabled: boolean;
  notice: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onWipe: () => void;
}

/**
 * Le panneau des conversations : nouvelle conversation, liste, suppression,
 * et « Tout effacer » avec confirmation.
 *
 * La confirmation se fait dans le panneau, en deux clics, plutôt qu'avec
 * window.confirm : une boîte modale du navigateur bloque toute la page (et
 * le streaming en cours) tant qu'on n'a pas répondu.
 */
export function ConversationSidebar({
  items,
  currentId,
  currentIsNew,
  disabled,
  notice,
  onCreate,
  onSelect,
  onDelete,
  onWipe,
}: ConversationSidebarProps) {
  const [confirmingWipe, setConfirmingWipe] = useState(false);

  return (
    <aside className="conversations" aria-label="Conversations">
      <button type="button" className="conversations__new" onClick={onCreate} disabled={disabled || currentIsNew}>
        + Nouvelle conversation
      </button>

      {notice && (
        <p className="conversations__notice" role="status">
          {notice}
        </p>
      )}

      <ul className="conversations__list">
        {currentIsNew && (
          <li className="conversations__item conversations__item--current">
            <span className="conversations__title conversations__title--draft">Nouvelle conversation</span>
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.id}
            className={`conversations__item${item.id === currentId ? " conversations__item--current" : ""}${item.illisible ? " conversations__item--unreadable" : ""}`}
          >
            <button
              type="button"
              className="conversations__select"
              onClick={() => onSelect(item.id)}
              disabled={disabled}
              aria-current={item.id === currentId ? "true" : undefined}
              title={item.illisible ? "Illisible : données corrompues ou clé perdue" : item.titre}
            >
              <span className="conversations__title">{item.illisible ? "Conversation illisible" : item.titre}</span>
              <span className="conversations__date">{item.illisible ? "contenu indéchiffrable" : formatDate(item.modifieLe)}</span>
            </button>
            <button
              type="button"
              className="conversations__delete"
              onClick={() => onDelete(item.id)}
              disabled={disabled}
              aria-label={item.illisible ? "Supprimer cette conversation illisible" : `Supprimer « ${item.titre} »`}
              title="Supprimer"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="conversations__footer">
        {confirmingWipe ? (
          <div className="conversations__confirm" role="alertdialog" aria-label="Confirmer l'effacement">
            <p>Effacer toutes les conversations et la clé ? Rien ne sera récupérable.</p>
            <div className="conversations__confirm-actions">
              <button
                type="button"
                className="conversations__danger"
                onClick={() => {
                  setConfirmingWipe(false);
                  onWipe();
                }}
              >
                Tout effacer
              </button>
              <button type="button" className="conversations__ghost" onClick={() => setConfirmingWipe(false)}>
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="conversations__ghost"
            onClick={() => setConfirmingWipe(true)}
            disabled={disabled}
          >
            Tout effacer…
          </button>
        )}
        <p className="conversations__hint">Historique chiffré, conservé dans ce navigateur uniquement.</p>
      </div>
    </aside>
  );
}

/** « 14:32 » aujourd'hui, « 12 oct. » sinon. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
