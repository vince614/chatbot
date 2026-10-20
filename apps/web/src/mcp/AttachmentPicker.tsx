import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { Attachment } from "../chat/types";
import type { McpResource } from "./api";
import type { CatalogState } from "./useMcpCatalog";

interface AttachmentPickerProps {
  resources: readonly McpResource[];
  state: CatalogState;
  attached: readonly Attachment[];
  max: number;
  disabled: boolean;
  onAdd: (attachment: Attachment) => void;
}

/** Bouton « Joindre » et sa liste de ressources, navigable au clavier. */
export function AttachmentPicker({ resources, state, attached, max, disabled, onAdd }: AttachmentPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const full = attached.length >= max;
  const isAttached = (uri: string) => attached.some((item) => item.uri === uri);
  const unavailable = state === "unavailable";
  const buttonDisabled = disabled || state !== "ready" || full;
  const buttonTitle = unavailable
    ? "Ressources indisponibles"
    : full
      ? `${max} pièces jointes maximum`
      : state === "loading"
        ? "Chargement des ressources…"
        : "Joindre une ressource";

  // Liste ouverte : clic à l'extérieur ferme, et le focus passe à la liste pour le clavier.
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Plus possible d'ajouter (limite atteinte, génération en cours) : la liste se ferme.
  useEffect(() => {
    if (buttonDisabled) setOpen(false);
  }, [buttonDisabled]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const choose = (resource: McpResource) => {
    if (isAttached(resource.uri) || full) return;
    onAdd({ uri: resource.uri, name: resource.name });
    close();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % Math.max(resources.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + resources.length) % Math.max(resources.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const resource = resources[activeIndex];
      if (resource) choose(resource);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className="attach" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="attach__button"
        disabled={buttonDisabled}
        title={buttonTitle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setActiveIndex(0);
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">📎</span> Joindre
        {unavailable && <span className="attach__note"> (indisponible)</span>}
        {full && <span className="attach__note"> ({attached.length}/{max})</span>}
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          className="mcp-list attach__list"
          role="listbox"
          tabIndex={-1}
          aria-label="Ressources à joindre"
          aria-activedescendant={resources.length > 0 ? optionId(activeIndex) : undefined}
          onKeyDown={handleKeyDown}
        >
          {resources.length === 0 && <li className="mcp-list__empty">Aucune ressource disponible.</li>}
          {resources.map((resource, index) => {
            const already = isAttached(resource.uri);
            return (
              <li
                key={resource.uri}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={already}
                className={`mcp-list__option${index === activeIndex ? " mcp-list__option--active" : ""}${already ? " mcp-list__option--disabled" : ""}`}
                // mousedown garde le focus sur la liste, le clic choisit.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(resource)}
              >
                <span className="mcp-list__title">{resource.title ?? resource.name}</span>
                {already && <span className="mcp-list__tag">jointe</span>}
                {resource.description && <span className="mcp-list__description">{resource.description}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
