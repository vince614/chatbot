import { useState, type KeyboardEvent } from "react";

interface ComposerProps {
  /** Vrai pendant la génération : saisie bloquée, bouton Stop affiché. */
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Si renseigné, l'envoi est impossible et ce texte en explique la raison. */
  lockedHint?: string;
}

export function Composer({ disabled, onSend, onStop, lockedHint }: ComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (disabled || lockedHint || !draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Entrée envoie, Maj+Entrée insère un saut de ligne.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {lockedHint && (
        <p className="composer__hint" id="composer-hint">
          {lockedHint}
        </p>
      )}
      <textarea
        className="composer__input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "Génération en cours…" : "Écris un message (Maj+Entrée pour un saut de ligne)"}
        rows={2}
        disabled={disabled || Boolean(lockedHint)}
        aria-describedby={lockedHint ? "composer-hint" : undefined}
        autoFocus
      />
      {disabled ? (
        <button type="button" className="composer__button composer__button--stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" className="composer__button" disabled={!draft.trim() || Boolean(lockedHint)}>
          Envoyer
        </button>
      )}
    </form>
  );
}
