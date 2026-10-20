import { ChatError } from "../chat/api";

/** Une ressource MCP (un document) que l'utilisateur peut joindre à un message. */
export type McpResource = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type McpPromptArgument = {
  name: string;
  description?: string;
  required: boolean;
};

/** Un prompt MCP proposé dans le menu « / ». */
export type McpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgument[];
};

/** GET /api/mcp/resources, pour l'utilisateur déclaré. */
export async function fetchResources(userId: string, signal: AbortSignal): Promise<McpResource[]> {
  const body = await requestJson<{ resources?: McpResource[] }>("/api/mcp/resources", userId, { signal });
  return body.resources ?? [];
}

/** GET /api/mcp/prompts, pour l'utilisateur déclaré. */
export async function fetchPrompts(userId: string, signal: AbortSignal): Promise<McpPrompt[]> {
  const body = await requestJson<{ prompts?: McpPrompt[] }>("/api/mcp/prompts", userId, { signal });
  return body.prompts ?? [];
}

/**
 * Valeurs proposées par le serveur pour un argument de prompt. `context`
 * donne les autres arguments déjà saisis, pour des suggestions qui en dépendent.
 */
export async function completeArgument(
  userId: string,
  request: { prompt: string; argument: string; value: string; arguments?: Record<string, string> },
  signal: AbortSignal,
): Promise<string[]> {
  const body = await requestJson<{ values?: string[] }>("/api/mcp/complete", userId, {
    method: "POST",
    body: JSON.stringify(request),
    signal,
  });
  return body.values ?? [];
}

async function requestJson<T>(url: string, userId: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
      // Même remplaçant d'authentification que streamChat (voir chat/api.ts).
      "X-User-Id": userId,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ChatError(body?.error ?? `Service MCP indisponible (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}
