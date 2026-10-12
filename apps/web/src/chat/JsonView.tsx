import { useState } from "react";

interface JsonViewProps {
  value: unknown;
  /** Profondeur jusqu'à laquelle les objets sont dépliés au départ. */
  expandDepth?: number;
}

/** Au-dessous de cette taille (sérialisée), un objet ou un tableau tient sur une ligne. */
const INLINE_LIMIT = 80;

/**
 * Rendu lisible d'une valeur JSON : couleurs par type, objets et tableaux
 * repliables, chaînes multilignes affichées avec leurs sauts de ligne.
 */
export function JsonView({ value, expandDepth = 2 }: JsonViewProps) {
  // Une valeur courte reste sur la ligne de son libellé, une longue passe en dessous.
  const inline = typeof value !== "object" || value === null || isInline(value);
  return (
    <span className={`json ${inline ? "json--inline" : "json--block"}`}>
      <JsonNode value={value} depth={0} expandDepth={expandDepth} />
    </span>
  );
}

interface JsonNodeProps {
  value: unknown;
  depth: number;
  expandDepth: number;
}

function JsonNode({ value, depth, expandDepth }: JsonNodeProps) {
  const [open, setOpen] = useState(depth < expandDepth);

  if (value === null) return <span className="json__null">null</span>;
  if (typeof value === "string") return <span className="json__string">"{value}"</span>;
  if (typeof value === "number") return <span className="json__number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json__boolean">{String(value)}</span>;
  if (typeof value !== "object") return <span className="json__null">{String(value)}</span>;

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const [openBracket, closeBracket] = isArray ? ["[", "]"] : ["{", "}"];

  if (entries.length === 0) {
    return <span className="json__bracket">{openBracket + closeBracket}</span>;
  }

  // Petit objet : une seule ligne, sans bouton de repli.
  if (isInline(value)) {
    return (
      <span>
        <span className="json__bracket">{openBracket} </span>
        {entries.map(([key, item], index) => (
          <span key={key}>
            {!isArray && <span className="json__key">{key}: </span>}
            <JsonNode value={item} depth={depth + 1} expandDepth={expandDepth} />
            {index < entries.length - 1 && <span className="json__punct">, </span>}
          </span>
        ))}
        <span className="json__bracket"> {closeBracket}</span>
      </span>
    );
  }

  return (
    <span>
      <button
        type="button"
        className="json__toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={open ? "Replier" : "Déplier"}
      >
        {open ? "▾" : "▸"}
      </button>
      <span className="json__bracket">{openBracket}</span>
      {open ? (
        <>
          <div className="json__children">
            {entries.map(([key, item]) => (
              <div key={key} className="json__row">
                <span className={isArray ? "json__index" : "json__key"}>{key}: </span>
                <JsonNode value={item} depth={depth + 1} expandDepth={expandDepth} />
              </div>
            ))}
          </div>
          <span className="json__bracket">{closeBracket}</span>
        </>
      ) : (
        <span className="json__summary" onClick={() => setOpen(true)}>
          {" "}
          {isArray ? `${entries.length} élément${entries.length > 1 ? "s" : ""}` : `${entries.length} clé${entries.length > 1 ? "s" : ""}`}{" "}
          <span className="json__bracket">{closeBracket}</span>
        </span>
      )}
    </span>
  );
}

function isInline(value: object): boolean {
  try {
    const text = JSON.stringify(value);
    return text.length <= INLINE_LIMIT && !text.includes("\\n");
  } catch {
    return false;
  }
}
