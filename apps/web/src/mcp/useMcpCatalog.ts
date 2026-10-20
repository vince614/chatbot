import { useEffect, useState } from "react";

import { fetchPrompts, fetchResources, type McpPrompt, type McpResource } from "./api";

export type CatalogState = "loading" | "ready" | "unavailable";

export interface McpCatalog {
  resources: McpResource[];
  prompts: McpPrompt[];
  resourcesState: CatalogState;
  promptsState: CatalogState;
}

const EMPTY: McpCatalog = { resources: [], prompts: [], resourcesState: "loading", promptsState: "loading" };

/**
 * Charge les ressources et les prompts MCP de l'utilisateur, et les recharge
 * quand il change. Les deux listes sont indépendantes : l'échec de l'une
 * (503) la marque « indisponible » sans toucher à l'autre, ni au chat.
 */
export function useMcpCatalog(userId: string): McpCatalog {
  const [catalog, setCatalog] = useState<McpCatalog>(EMPTY);

  useEffect(() => {
    // Pas d'utilisateur : rien à demander, et surtout rien à garder de l'ancien.
    setCatalog(userId ? EMPTY : { ...EMPTY, resourcesState: "unavailable", promptsState: "unavailable" });
    if (!userId) return;

    const controller = new AbortController();
    fetchResources(userId, controller.signal)
      .then((resources) => setCatalog((prev) => ({ ...prev, resources, resourcesState: "ready" })))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog((prev) => ({ ...prev, resources: [], resourcesState: "unavailable" }));
      });
    fetchPrompts(userId, controller.signal)
      .then((prompts) => setCatalog((prev) => ({ ...prev, prompts, promptsState: "ready" })))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog((prev) => ({ ...prev, prompts: [], promptsState: "unavailable" }));
      });
    return () => controller.abort();
  }, [userId]);

  return catalog;
}
