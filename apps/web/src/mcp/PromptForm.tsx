import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { completeArgument, type McpPrompt, type McpPromptArgument } from "./api";

/** Délai après la dernière frappe avant de demander des suggestions au serveur. */
const COMPLETE_DELAY_MS = 200;

interface PromptFormProps {
  prompt: McpPrompt;
  userId: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/** Formulaire des arguments d'un prompt, un champ avec autocomplétion par argument. */
export function PromptForm({ prompt, userId, onSubmit, onCancel }: PromptFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const titleId = useId();

  const canSubmit = prompt.arguments.every((argument) => !argument.required || values[argument.name]?.trim());

  const submit = () => {
    if (!canSubmit) return;
    const cleaned: Record<string, string> = {};
    for (const argument of prompt.arguments) {
      const value = values[argument.name]?.trim();
      if (value) cleaned[argument.name] = value;
    }
    onSubmit(cleaned);
  };

  return (
    <form
      className="prompt-form"
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      // Les champs ferment d'abord leur propre liste (stopPropagation) ; ici, c'est l'annulation.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="prompt-form__title" id={titleId}>
        <span className="badge">prompt</span> {prompt.title ?? prompt.name}
        <span className="prompt-form__name"> /{prompt.name}</span>
      </p>
      {prompt.description && <p className="prompt-form__description">{prompt.description}</p>}
      {prompt.arguments.map((argument, index) => (
        <ArgumentField
          key={argument.name}
          promptName={prompt.name}
          argument={argument}
          userId={userId}
          value={values[argument.name] ?? ""}
          context={values}
          autoFocus={index === 0}
          onChange={(value) => setValues((prev) => ({ ...prev, [argument.name]: value }))}
        />
      ))}
      <div className="prompt-form__actions">
        <button type="button" className="prompt-form__cancel" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="composer__button prompt-form__submit" disabled={!canSubmit}>
          Envoyer le prompt
        </button>
      </div>
    </form>
  );
}

interface ArgumentFieldProps {
  promptName: string;
  argument: McpPromptArgument;
  userId: string;
  value: string;
  /** Les autres arguments déjà saisis, envoyés au serveur pour affiner les suggestions. */
  context: Record<string, string>;
  autoFocus: boolean;
  onChange: (value: string) => void;
}

function ArgumentField({ promptName, argument, userId, value, context, autoFocus, onChange }: ArgumentFieldProps) {
  const inputId = useId();
  const listId = `${inputId}-list`;
  // Texte dont on veut des suggestions : seulement après une frappe ou le focus,
  // jamais après le choix d'une suggestion (null = liste fermée).
  const [query, setQuery] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Dernières valeurs lues par l'effet de recherche sans le relancer à chaque frappe d'un autre champ.
  const latest = useRef({ userId, context });
  useEffect(() => {
    latest.current = { userId, context };
  });

  useEffect(() => {
    if (query === null) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const { userId: currentUser, context: others } = latest.current;
      const { [argument.name]: _self, ...rest } = others;
      completeArgument(
        currentUser,
        { prompt: promptName, argument: argument.name, value: query, ...(Object.keys(rest).length > 0 && { arguments: rest }) },
        controller.signal,
      )
        .then((values) => {
          setSuggestions(values);
          setActiveIndex(-1);
        })
        // L'autocomplétion est un confort : en cas d'échec, la saisie libre reste possible.
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, COMPLETE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, promptName, argument.name]);

  const open = query !== null && suggestions.length > 0;

  const pick = (suggestion: string) => {
    onChange(suggestion);
    setQuery(null);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      // Entrée choisit la suggestion surlignée au lieu de valider le formulaire.
      event.preventDefault();
      const suggestion = suggestions[activeIndex];
      if (suggestion !== undefined) pick(suggestion);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery(null);
    }
  };

  return (
    <div className="prompt-field">
      <label htmlFor={inputId} className="prompt-field__label">
        {argument.name}
        {argument.required && (
          <span className="prompt-field__required" title="Requis">
            {" "}
            *
          </span>
        )}
      </label>
      <input
        id={inputId}
        className="prompt-field__input"
        type="text"
        value={value}
        placeholder={argument.description}
        required={argument.required}
        autoComplete="off"
        autoFocus={autoFocus}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
        }}
        onFocus={() => setQuery(value)}
        onBlur={() => setQuery(null)}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <ul id={listId} className="mcp-list prompt-field__list" role="listbox" aria-label={`Suggestions pour ${argument.name}`}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`mcp-list__option${index === activeIndex ? " mcp-list__option--active" : ""}`}
              // mousedown avant le blur du champ, sinon la liste disparaît avant le clic.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pick(suggestion)}
            >
              <span className="mcp-list__title">{suggestion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
