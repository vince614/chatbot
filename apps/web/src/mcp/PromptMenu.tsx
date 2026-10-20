import type { McpPrompt } from "./api";
import type { CatalogState } from "./useMcpCatalog";

interface PromptMenuProps {
  /** Id de la liste, repris par `aria-controls` du champ de saisie. */
  listId: string;
  prompts: readonly McpPrompt[];
  state: CatalogState;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (prompt: McpPrompt) => void;
}

export function promptOptionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

/**
 * Liste des prompts affichée sous la saisie « / ». Elle ne prend pas le focus :
 * le clavier reste dans le textarea, qui pilote `activeIndex` (combobox).
 */
export function PromptMenu({ listId, prompts, state, activeIndex, onHover, onSelect }: PromptMenuProps) {
  if (state !== "ready") {
    return (
      <div className="mcp-list prompt-menu" role="status">
        <p className="mcp-list__empty">{state === "loading" ? "Chargement des prompts…" : "Prompts indisponibles."}</p>
      </div>
    );
  }
  return (
    <ul id={listId} className="mcp-list prompt-menu" role="listbox" aria-label="Prompts">
      {prompts.length === 0 && <li className="mcp-list__empty">Aucun prompt ne correspond.</li>}
      {prompts.map((prompt, index) => (
        <li
          key={prompt.name}
          id={promptOptionId(listId, index)}
          role="option"
          aria-selected={index === activeIndex}
          className={`mcp-list__option${index === activeIndex ? " mcp-list__option--active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(prompt)}
        >
          <span className="mcp-list__title">{prompt.title ?? prompt.name}</span>
          <span className="mcp-list__tag">/{prompt.name}</span>
          {prompt.description && <span className="mcp-list__description">{prompt.description}</span>}
        </li>
      ))}
    </ul>
  );
}
