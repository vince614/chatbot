import type { z } from "zod";

/**
 * Un outil que le modèle peut demander. Ce module ne connaît ni le LLM ni
 * Fastify : il décrit une capacité, c'est tout.
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  /** Nom tel que le modèle le verra et l'appellera (snake_case). */
  name: string;
  /** Décrit au modèle quand et comment utiliser l'outil. Plus c'est précis, mieux il choisit. */
  description: string;
  /** Schéma Zod des arguments. Sert à la validation et à la génération du JSON Schema. */
  schema: S;
  /** Exécute l'outil. Le résultat sera sérialisé en JSON pour le modèle. */
  execute(input: z.infer<S>, context: ToolContext): Promise<unknown>;
  /** Délai propre à l'outil, en millisecondes ; sinon, celui de l'appelant. */
  timeoutMs?: number;
}

/**
 * Un outil défini ailleurs (un serveur MCP) : son schéma arrive déjà en JSON
 * Schema et c'est le serveur qui valide les arguments. Le registre ne fait
 * que transmettre.
 */
export interface ExternalTool {
  name: string;
  description: string;
  /** JSON Schema des arguments, transmis tel quel au modèle. */
  inputSchema: Record<string, unknown>;
  /** Exécute l'outil. Le résultat est déjà sous sa forme finale : texte et succès ou échec. */
  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult>;
  timeoutMs?: number;
}

/** Ce que le registre accepte : un outil maison (Zod) ou un outil externe (JSON Schema). */
export type AnyTool = Tool | ExternalTool;

export interface ToolContext {
  /** Déclenché si le client se déconnecte ou si le délai est dépassé. */
  signal: AbortSignal;
}

/** Description d'un outil, prête à être transmise à un LLM. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Résultat d'une exécution. Jamais d'exception : une erreur est un résultat comme un autre. */
export interface ToolExecutionResult {
  ok: boolean;
  /** Contenu à renvoyer au modèle : JSON du résultat, ou message d'erreur lisible. */
  content: string;
}
