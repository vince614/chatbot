import { ToolMessage } from "@langchain/core/messages";
import { ToolInputParsingException } from "@langchain/core/tools";
import { createMiddleware, ToolInvocationError } from "langchain";

/** Délai d'un outil qui n'en fixe pas lui-même (metadata.timeoutMs). */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Ce qu'un outil déclare au garde, dans ses `metadata`. */
export interface ToolPolicy {
  /** Vrai si l'outil ne fait que lire. Absent : action, confirmation requise. */
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface ToolGuardOptions {
  /**
   * Demande à l'utilisateur s'il autorise un outil à effet de bord. Absent :
   * personne ne peut confirmer, tout outil à effet de bord est refusé.
   */
  confirm?: (call: { name: string; input: unknown }) => Promise<boolean>;
}

/**
 * Ce que le modèle lit quand une action est refusée. Factuel, sans détour à
 * suggérer : le modèle doit le dire à l'utilisateur, pas chercher un autre outil.
 */
export function confirmationRequired(name: string): string {
  return (
    `Action refusée : l'outil "${name}" modifie quelque chose hors de cette conversation et exige ` +
    "la confirmation explicite de l'utilisateur, qui n'a pas été donnée. Ne réessaie pas. Dis à " +
    "l'utilisateur quelle action a été demandée et pourquoi elle n'a pas été faite."
  );
}

/**
 * Le garde des outils, en middleware LangChain : il entoure chaque appel
 * d'outil de l'agent (wrapToolCall). C'est ce qui restait de notre registre
 * (jour 1) une fois que LangChain fait la validation des arguments et
 * l'exécution :
 *  - OWASP LLM01 : un outil qui ne se déclare pas en lecture seule n'est
 *    exécuté qu'avec une confirmation humaine (refus par défaut) ;
 *  - un délai par outil ;
 *  - toute erreur devient un résultat d'outil lisible (status "error") que le
 *    modèle lit, au lieu du « Please fix your mistakes. » de LangChain.
 */
export function toolGuard({ confirm }: ToolGuardOptions = {}) {
  return createMiddleware({
    name: "ToolGuard",
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const policy = ((request.tool as { metadata?: ToolPolicy } | undefined)?.metadata ?? {}) satisfies ToolPolicy;
      const fail = (content: string) =>
        new ToolMessage({ content, tool_call_id: toolCall.id ?? "", name: toolCall.name, status: "error" });

      // Un nom que le modèle a inventé : l'agent n'a aucun outil à exécuter.
      if (!request.tool) return fail(`Outil inconnu : "${toolCall.name}".`);
      if (policy.readOnly !== true && !(confirm && (await confirm({ name: toolCall.name, input: toolCall.args })))) {
        return fail(confirmationRequired(toolCall.name));
      }

      const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolCall.name, timeoutMs)), timeoutMs);
      });
      try {
        return await Promise.race([handler(request), timeout]);
      } catch (error) {
        // Une déconnexion du client n'est pas un échec de l'outil : on la laisse remonter.
        if (request.runtime.signal?.aborted) throw error;
        // LangChain enveloppe l'erreur de l'outil, et son message contient la
        // pile d'appels (chemins du serveur) : on ne transmet que la cause.
        const cause = ToolInvocationError.isInstance(error) ? error.toolError : error;
        if (cause instanceof ToolInputParsingException) return fail(`Arguments invalides. ${schemaIssues(cause.message)}`);
        return fail(cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/**
 * Les problèmes de schéma, sans le reste : « expression : L'expression est vide. ».
 * zod les écrit « ✖ <message> » puis « → at <chemin> ».
 */
function schemaIssues(message: string): string {
  const issues: string[] = [];
  for (const line of message.split("\n")) {
    const issue = /^✖ (.*)$/.exec(line.trim());
    if (issue) issues.push(issue[1]!);
    const path = /^→ at (.*)$/.exec(line.trim());
    if (path && issues.length > 0) issues[issues.length - 1] = `${path[1]} : ${issues.at(-1)}`;
  }
  return issues.length > 0 ? issues.join(" ; ") : "Les arguments ne respectent pas le schéma de l'outil.";
}

class ToolTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`L'outil "${name}" a dépassé le délai de ${timeoutMs} ms.`);
  }
}
