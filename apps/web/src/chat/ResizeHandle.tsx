import type { PointerEvent } from "react";

interface ResizeHandleProps {
  /** "vertical" : barre verticale, on règle une largeur. "horizontal" : barre horizontale, on règle une hauteur. */
  orientation: "vertical" | "horizontal";
  /** Taille courante du panneau (largeur ou hauteur, en pixels). */
  size: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  onCommit?: (size: number) => void;
}

/**
 * Barre à glisser entre le chat et le journal. Le panneau est à droite ou en
 * bas de la barre : tirer vers la gauche ou vers le haut l'agrandit.
 */
export function ResizeHandle({ orientation, size, min, max, onChange, onCommit }: ResizeHandleProps) {
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const start = orientation === "vertical" ? event.clientX : event.clientY;
    const startSize = size;
    let latest = size;

    const clamp = (value: number) => Math.min(max, Math.max(min, value));

    const handleMove = (move: globalThis.PointerEvent) => {
      const current = orientation === "vertical" ? move.clientX : move.clientY;
      // Le panneau est après la barre : avancer la souris le réduit.
      latest = clamp(startSize - (current - start));
      onChange(latest);
    };

    const handleUp = () => {
      target.removeEventListener("pointermove", handleMove);
      target.removeEventListener("pointerup", handleUp);
      target.removeEventListener("pointercancel", handleUp);
      document.body.classList.remove(`resizing-${orientation}`);
      onCommit?.(latest);
    };

    document.body.classList.add(`resizing-${orientation}`);
    target.addEventListener("pointermove", handleMove);
    target.addEventListener("pointerup", handleUp);
    target.addEventListener("pointercancel", handleUp);
  };

  return (
    <div
      className={`resize-handle resize-handle--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label="Redimensionner le journal"
      onPointerDown={handlePointerDown}
    />
  );
}
