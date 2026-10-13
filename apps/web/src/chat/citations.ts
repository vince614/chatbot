import type { Source } from "./types";

/** Préfixe des ancres : un lien Markdown `#source-<id>-<n>` est une citation. */
const HREF_PREFIX = "source-";

/** Blocs ``` (même non refermé, pendant le streaming) ou code inline : à ne jamais toucher. */
const CODE_PATTERN = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
/** `[n]` sans être déjà un lien `[n](…)` ni une définition `[n]: …`. */
const CITATION_PATTERN = /\[(\d{1,2})\](?![(:])/g;

/**
 * Applique `replace` aux `[n]` hors code. Pure : le découpage sur CODE_PATTERN
 * (groupe capturant) place les morceaux de code aux indices impairs.
 */
function mapOutsideCode(text: string, replace: (match: string, n: number) => string): string {
  return text
    .split(CODE_PATTERN)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CITATION_PATTERN, (m, n: string) => replace(m, Number(n)))))
    .join("");
}

/** Ancre de la citation n dans le message `messageId` (sans le `#`). */
export function sourceAnchorId(messageId: string, n: number): string {
  return `${HREF_PREFIX}${messageId}-${n}`;
}

/**
 * Numéro de source visé par un href `#source-<messageId>-<n>`, ou null si ce
 * lien n'est pas une citation de ce message.
 */
export function parseCitationHref(href: string | undefined, messageId: string): number | null {
  const prefix = `#${HREF_PREFIX}${messageId}-`;
  if (!href?.startsWith(prefix)) return null;
  const n = Number(href.slice(prefix.length));
  return Number.isInteger(n) ? n : null;
}

/**
 * Transforme chaque `[n]` en lien Markdown `[n](#source-<messageId>-n)`, à
 * condition que n corresponde à une source de ce message. Les autres `[n]`
 * restent du texte, et le code (bloc ou inline) n'est jamais modifié.
 * Pure : même entrée, même sortie.
 */
export function linkifyCitations(text: string, sources: Source[] | undefined, messageId: string): string {
  if (!sources?.length) return text;
  const known = new Set(sources.map((s) => s.index));
  return mapOutsideCode(text, (match, n) => (known.has(n) ? `[${n}](#${sourceAnchorId(messageId, n)})` : match));
}

/**
 * Numéros de sources cités dans le texte, dans l'ordre de première apparition,
 * sans doublon. Ignore le code et les numéros sans source correspondante.
 * Pure.
 */
export function extractCitedIndexes(text: string, sources: Source[] | undefined): number[] {
  if (!sources?.length) return [];
  const known = new Set(sources.map((s) => s.index));
  const cited = new Set<number>();
  mapOutsideCode(text, (match, n) => {
    if (known.has(n)) cited.add(n);
    return match;
  });
  return [...cited];
}

/** « p. 3 » ou « p. 2–3 » (tiret demi-cadratin). */
export function formatPages(source: Pick<Source, "pageStart" | "pageEnd">): string {
  return source.pageEnd > source.pageStart ? `p. ${source.pageStart}–${source.pageEnd}` : `p. ${source.pageStart}`;
}
