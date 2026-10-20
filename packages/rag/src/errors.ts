/**
 * Décrire une erreur pour un LOG, sans la donnée qu'elle cite (OWASP LLM02).
 *
 * Les messages d'erreur citent volontiers ce qui a échoué : Postgres met la
 * valeur fautive entre guillemets, une API distante renvoie un corps JSON qui
 * peut reprendre l'entrée (la question, un extrait, un prompt). Recopier
 * error.message dans un log, c'est y recopier ces données.
 *
 * On garde ce qui sert au diagnostic — le type d'erreur, son code ou son
 * statut, la phrase technique — et on remplace tout texte entre guillemets
 * par « … ». Le message reste tronqué : un log n'est pas un dépôt de contenu.
 */

const QUOTED = /"[^"]*"|'[^']*'|«[^»]*»|“[^”]*”/g;
const MAX_LENGTH = 200;

export function safeErrorReason(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(safeErrorReason).join(" ; ");
  }
  if (!(error instanceof Error)) return "erreur non standard";
  const { code, status } = error as Error & { code?: unknown; status?: unknown };
  const tag = [error.name, typeof code === "string" ? code : undefined, typeof status === "number" ? `HTTP ${status}` : undefined]
    .filter(Boolean)
    .join(" ");
  const message = error.message.replace(QUOTED, "«…»").replace(/\s+/g, " ").trim();
  return `${tag}: ${message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message}`;
}
