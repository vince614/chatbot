/** Un événement SSE brut : nom de l'événement et payload texte (non parsé). */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parseur SSE incrémental. On lui pousse les chunks tels qu'ils arrivent du
 * réseau ; il renvoie les événements complets et garde en tampon tout
 * événement coupé en deux, qui sera terminé par le chunk suivant.
 */
export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
      // Normalise les fins de ligne. Un "\r" en fin de chunk sera recollé à
      // son "\n" au prochain push, puisqu'on normalise tout le tampon.
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");

      const events: SseEvent[] = [];
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseBlock(block);
        if (event) events.push(event);
        separator = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // commentaire ou ligne vide

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    // Les autres champs (id, retry) ne nous servent pas.
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}
