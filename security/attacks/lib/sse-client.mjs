// Petit client SSE pour /api/chat, partage par les attaques.
// N'utilise que fetch (Node 18+). Il envoie une requete de chat au nom d'un
// utilisateur (en-tete X-User-Id) et collecte tous les evenements du flux.
//
// Rappel : X-User-Id n'est PAS une authentification (voir
// apps/api/src/auth/fake-identity.ts). On exploite ici ce raccourci d'exercice
// pour jouer le role de l'utilisateur de test, en local.

const DEFAULT_BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";

/**
 * Envoie messages a /api/chat et renvoie un resume du flux.
 * @returns {Promise<{events:Array, text:string, toolCalls:Array, sources:Array, errors:Array, debug:Array}>}
 */
export async function chat({ userId, messages, debug = false, baseUrl = DEFAULT_BASE, signal } = {}) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": userId },
    body: JSON.stringify({ messages, debug }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} : ${body.slice(0, 300)}`);
  }

  const out = { events: [], text: "", toolCalls: [], sources: [], errors: [], debug: [] };
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    // Les evenements SSE sont separes par une ligne vide.
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseEvent(raw);
      if (evt) absorb(out, evt);
    }
  }
  return out;
}

function parseEvent(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = dataLines.join("\n");
  }
  return { event, data };
}

function absorb(out, evt) {
  out.events.push(evt);
  switch (evt.event) {
    case "delta":
      out.text += evt.data?.text ?? "";
      break;
    case "tool_call":
      out.toolCalls.push(evt.data);
      break;
    case "sources":
      out.sources = evt.data?.sources ?? [];
      break;
    case "error":
      out.errors.push(evt.data?.message ?? String(evt.data));
      break;
    case "debug":
      out.debug.push(evt.data);
      break;
    default:
      break;
  }
}
