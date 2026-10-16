import { z } from "zod";

import type { AnyTool, ExternalTool, ToolDescriptor, ToolExecutionResult } from "./types.js";

export interface ExecuteOptions {
  /** Annulation extérieure (déconnexion du client). */
  signal?: AbortSignal;
  /** Délai maximal d'exécution, en millisecondes, pour les outils qui n'en fixent pas. */
  timeoutMs?: number;
}

export interface ToolRegistry {
  /** Les outils disponibles, sous une forme transmissible à un LLM. */
  list(): ToolDescriptor[];
  /** Exécute un outil par son nom. Ne lève jamais : toute erreur devient { ok: false }. */
  execute(name: string, input: unknown, options?: ExecuteOptions): Promise<ToolExecutionResult>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Registre d'outils. Indépendant du reste de l'application : on pourra y
 * brancher d'autres sources d'outils sans toucher à la route ni au LLM.
 */
export function createToolRegistry(tools: AnyTool[]): ToolRegistry {
  const byName = new Map<string, AnyTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Outil déclaré deux fois : "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: isExternal(tool) ? tool.inputSchema : toInputSchema(tool.schema),
      }));
    },

    async execute(name, input, { signal, timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return failure(`Outil inconnu : "${name}".`);
      }
      const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;

      // Le délai et l'annulation extérieure se combinent en un seul signal.
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        if (isExternal(tool)) {
          // Pas de validation ici : le serveur de l'outil valide avec son propre schéma.
          return await Promise.race([tool.execute(input, { signal: combined }), rejectOnAbort(combined)]);
        }

        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) {
          const details = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
            .join(" ; ");
          return failure(`Arguments invalides. ${details}`);
        }

        const result = await Promise.race([
          tool.execute(parsed.data, { signal: combined }),
          rejectOnAbort(combined),
        ]);
        return { ok: true, content: JSON.stringify(result) };
      } catch (error) {
        // Une déconnexion du client n'est pas un échec de l'outil : on la laisse remonter.
        if (signal?.aborted) throw error;
        if (timeout.aborted) {
          return failure(`L'outil "${name}" a dépassé le délai de ${timeoutMs} ms.`);
        }
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  // Le "$schema" n'apporte rien au modèle ; le reste est un JSON Schema standard.
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema);
  return rest;
}

function isExternal(tool: AnyTool): tool is ExternalTool {
  return "inputSchema" in tool;
}

function failure(message: string): ToolExecutionResult {
  return { ok: false, content: message };
}

/** Promesse qui rejette quand le signal se déclenche, pour borner un outil qui ignorerait le signal. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
