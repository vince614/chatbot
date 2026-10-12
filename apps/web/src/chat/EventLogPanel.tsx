import { useEffect, useMemo, useRef, useState } from "react";

import { JsonView } from "./JsonView";
import type { LogEntry, LogKind } from "./types";

export type LogPlacement = "side" | "bottom";

interface EventLogPanelProps {
  entries: LogEntry[];
  placement: LogPlacement;
  onClear: () => void;
  onTogglePlacement: () => void;
}

/** Ordre et libellé des filtres par type. */
const KINDS: { kind: LogKind; label: string }[] = [
  { kind: "action", label: "actions" },
  { kind: "send", label: "envoi" },
  { kind: "http", label: "http" },
  { kind: "sse", label: "sse" },
  { kind: "model", label: "modèle" },
  { kind: "state", label: "état" },
];

interface Filters {
  kinds: Record<LogKind, boolean>;
  /** Les deltas sont nombreux : on peut les masquer sans masquer les autres événements SSE. */
  showDeltas: boolean;
  query: string;
}

const DEFAULT_FILTERS: Filters = {
  kinds: { action: true, send: true, http: true, sse: true, model: true, state: true },
  showDeltas: true,
  query: "",
};

/**
 * Journal en temps réel de ce que fait le hook useChat : envoi, statut HTTP,
 * chaque événement SSE, échanges avec le modèle, changements d'état. Outil
 * d'apprentissage, sans effet sur le fonctionnement du chat.
 */
export function EventLogPanel({ entries, placement, onClear, onTogglePlacement }: EventLogPanelProps) {
  const bottomRef = useRef<HTMLLIElement>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  const visible = useMemo(() => entries.filter((entry) => matches(entry, filters)), [entries, filters]);

  // Suit la dernière ligne visible, comme la liste des messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [visible]);

  const toggleKind = (kind: LogKind) =>
    setFilters((prev) => ({ ...prev, kinds: { ...prev.kinds, [kind]: !prev.kinds[kind] } }));

  return (
    <aside className="event-log" aria-label="Journal des événements">
      <header className="event-log__header">
        <div className="event-log__title">
          <h2>Journal</h2>
          <span className="event-log__count">
            {visible.length === entries.length ? entries.length : `${visible.length} / ${entries.length}`}
          </span>
        </div>
        <div className="event-log__actions">
          <button type="button" className="event-log__button" onClick={onTogglePlacement}>
            {placement === "side" ? "Mettre en dessous" : "Mettre à droite"}
          </button>
          <button type="button" className="event-log__button" onClick={onClear} disabled={entries.length === 0}>
            Vider
          </button>
        </div>
      </header>

      <div className="event-log__filters">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className={`chip chip--${kind} ${filters.kinds[kind] ? "chip--on" : ""}`}
            aria-pressed={filters.kinds[kind]}
            onClick={() => toggleKind(kind)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`chip chip--sse ${filters.showDeltas ? "chip--on" : ""}`}
          aria-pressed={filters.showDeltas}
          disabled={!filters.kinds.sse}
          onClick={() => setFilters((prev) => ({ ...prev, showDeltas: !prev.showDeltas }))}
        >
          deltas
        </button>
        <input
          type="search"
          className="event-log__search"
          placeholder="Filtrer le texte…"
          value={filters.query}
          onChange={(event) => setFilters((prev) => ({ ...prev, query: event.target.value }))}
        />
      </div>

      {visible.length === 0 ? (
        <p className="event-log__empty">
          {entries.length === 0 ? "Envoie un message pour voir le flux." : "Aucune ligne ne correspond aux filtres."}
        </p>
      ) : (
        <ul className="event-log__list">
          {visible.map((entry) => (
            <li key={entry.id} className={entryClassName(entry)}>
              <span className="event-log__time">{entry.time}</span>
              <span className="event-log__kind">{entry.kind}</span>
              <span className="event-log__message">
                {entry.message}
                {entry.data !== undefined && (
                  <JsonView value={entry.data} expandDepth={entry.kind === "model" ? 3 : 1} />
                )}
              </span>
            </li>
          ))}
          <li ref={bottomRef} aria-hidden="true" />
        </ul>
      )}
    </aside>
  );
}

function matches(entry: LogEntry, filters: Filters): boolean {
  if (!filters.kinds[entry.kind]) return false;
  if (entry.kind === "sse" && !filters.showDeltas && entry.message === "delta") return false;
  const query = filters.query.trim().toLowerCase();
  if (query === "") return true;
  const haystack = `${entry.message} ${entry.data === undefined ? "" : JSON.stringify(entry.data)}`;
  return haystack.toLowerCase().includes(query);
}

function entryClassName(entry: LogEntry): string {
  const classes = ["event-log__entry", `event-log__entry--${entry.kind}`];
  if (entry.kind === "sse") {
    if (entry.message === "error") classes.push("event-log__entry--error");
    else if (entry.message !== "delta") classes.push("event-log__entry--highlight");
  }
  return classes.join(" ");
}
