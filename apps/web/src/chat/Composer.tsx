import { useId, useMemo, useState, type KeyboardEvent } from "react";

import { AttachmentChips } from "../mcp/AttachmentChips";
import { AttachmentPicker } from "../mcp/AttachmentPicker";
import type { McpPrompt } from "../mcp/api";
import { PromptForm } from "../mcp/PromptForm";
import { PromptMenu, promptOptionId } from "../mcp/PromptMenu";
import type { McpCatalog } from "../mcp/useMcpCatalog";
import type { Attachment, SendInput } from "./types";

/** Limite côté serveur, reprise ici pour désactiver l'ajout plutôt que de laisser le serveur refuser. */
const MAX_ATTACHMENTS = 3;
/** Limite du `content` côté serveur : le libellé d'un prompt y est copié. */
const MAX_CONTENT = 8000;

interface ComposerProps {
  /** Vrai pendant la génération : saisie bloquée, bouton Stop affiché. */
  disabled: boolean;
  onSend: (input: SendInput) => void;
  onStop: () => void;
  /** Si renseigné, l'envoi est impossible et ce texte en explique la raison. */
  lockedHint?: string;
  userId: string;
  catalog: McpCatalog;
}

export function Composer({ disabled, onSend, onStop, lockedHint, userId, catalog }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Prompt choisi dans le menu « / » : son formulaire remplace le menu.
  const [selectedPrompt, setSelectedPrompt] = useState<McpPrompt | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();

  const locked = disabled || Boolean(lockedHint);
  const menuOpen = draft.startsWith("/") && !menuDismissed && !locked && selectedPrompt === null;
  // Filtré sur ce qui suit « / » : nom, titre ou description.
  const matches = useMemo(() => {
    if (!menuOpen) return [];
    const needle = draft.slice(1).trim().toLowerCase();
    return catalog.prompts.filter((prompt) =>
      [prompt.name, prompt.title, prompt.description].some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [menuOpen, draft, catalog.prompts]);
  const listNavigable = menuOpen && catalog.promptsState === "ready" && matches.length > 0;
  const safeActive = Math.min(activeIndex, Math.max(matches.length - 1, 0));

  const submit = () => {
    if (locked || !draft.trim()) return;
    onSend({ text: draft, ...(attachments.length > 0 && { attachments }) });
    setDraft("");
    setAttachments([]);
  };

  const choosePrompt = (prompt: McpPrompt) => {
    setSelectedPrompt(prompt);
    setDraft("");
  };

  const submitPrompt = (prompt: McpPrompt, args: Record<string, string>) => {
    const summary = Object.entries(args)
      .map(([name, value]) => `${name} = ${value}`)
      .join(", ");
    const label = `/${prompt.name}${summary ? ` · ${summary}` : ""}`.slice(0, MAX_CONTENT);
    onSend({ text: label, prompt: { name: prompt.name, arguments: args } });
    setSelectedPrompt(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setMenuDismissed(true);
      return;
    }
    if (listNavigable) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((safeActive + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((safeActive - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const prompt = matches[safeActive];
        if (prompt) choosePrompt(prompt);
        return;
      }
    }
    // Entrée envoie, Maj+Entrée insère un saut de ligne.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      {selectedPrompt && (
        <PromptForm
          // Un autre prompt repart d'un formulaire vierge.
          key={selectedPrompt.name}
          prompt={selectedPrompt}
          userId={userId}
          onSubmit={(args) => submitPrompt(selectedPrompt, args)}
          onCancel={() => setSelectedPrompt(null)}
        />
      )}
      {menuOpen && (
        <PromptMenu
          listId={menuId}
          prompts={matches}
          state={catalog.promptsState}
          activeIndex={safeActive}
          onHover={setActiveIndex}
          onSelect={choosePrompt}
        />
      )}
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
        <AttachmentChips items={attachments} onRemove={(uri) => setAttachments((prev) => prev.filter((a) => a.uri !== uri))} />
        <textarea
          className="composer__input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setMenuDismissed(false);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Génération en cours…" : "Écris un message, ou « / » pour un prompt (Maj+Entrée pour un saut de ligne)"}
          rows={2}
          disabled={locked}
          aria-describedby={lockedHint ? "composer-hint" : undefined}
          role="combobox"
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={listNavigable}
          aria-controls={listNavigable ? menuId : undefined}
          aria-activedescendant={listNavigable ? promptOptionId(menuId, safeActive) : undefined}
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
        <AttachmentPicker
          resources={catalog.resources}
          state={catalog.resourcesState}
          attached={attachments}
          max={MAX_ATTACHMENTS}
          disabled={locked}
          onAdd={(attachment) => setAttachments((prev) => [...prev, attachment])}
        />
      </form>
    </div>
  );
}
