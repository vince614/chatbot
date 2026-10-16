import type { Page } from "./types.js";

/**
 * Nettoyage du texte extrait d'un PDF. Fonctions pures : même entrée, même
 * sortie, aucun accès disque ni base.
 *
 * Ce que produit pdf.js : une ligne de texte par ligne du PDF, avec les
 * en-têtes et pieds de page, les mots coupés en fin de ligne, des ligatures
 * typographiques (ﬁ, ﬂ) et des espaces de toutes sortes. Ce qu'on veut : des
 * paragraphes propres, séparés par "\n\n".
 */

/** Nombre de lignes, en haut et en bas de chaque page, où l'on cherche en-têtes et pieds. */
const MARGIN_LINES = 2;
/** En dessous de ce nombre de pages, on ne peut pas parler de « ligne répétée ». */
const MIN_PAGES_FOR_REPEAT = 3;
/** Une ligne de marge présente sur au moins cette proportion des pages est un en-tête/pied. */
const REPEAT_RATIO = 0.5;

const BULLET = /^([•▪◦‣●○■*–—-]|\(?\d{1,3}[.)])\s/;
const TERMINAL_PUNCTUATION = /[.!?:;…»"”)]$/;
const HYPHENATED_END = /\p{L}-$/u;
const LOWERCASE_START = /^\p{Ll}/u;
const UPPERCASE_START = /^[\p{Lu}\d]/u;

export interface CleanResult {
  pages: Page[];
  /** Exemple de chaque en-tête/pied supprimé (pour l'aperçu). */
  removedMarginLines: string[];
}

export function cleanPages(rawPages: Page[]): CleanResult {
  const linesPerPage = rawPages.map((page) => normalizeCharacters(page.text).split("\n").map((line) => line.trim()));
  const repeated = findRepeatedMarginLines(linesPerPage);
  const removed = new Map<string, string>();

  const pages = rawPages.map((page, i) => {
    const lines = removeMarginLines(linesPerPage[i]!, repeated, removed);
    return { pageNumber: page.pageNumber, text: buildParagraphs(lines).join("\n\n") };
  });

  return { pages, removedMarginLines: [...removed.values()] };
}

/**
 * Normalise les caractères sans changer le sens :
 *  - ligatures typographiques (ﬁ → fi), fréquentes dans les PDF ;
 *  - tirets conditionnels et caractères invisibles supprimés ;
 *  - toutes les espaces (insécables, fines, tabulations) → une espace simple.
 */
export function normalizeCharacters(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKC"))
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[^\S\n]+/g, " ");
}

/**
 * Signature d'une ligne pour comparer les pages entre elles : en minuscules,
 * chaque nombre remplacé par #. Ainsi « Page 3 / 12 » et « Page 4 / 12 »
 * deviennent la même ligne « page # / # ».
 */
function signature(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#");
}

/** Indices des lignes non vides situées dans les marges haute et basse. */
function marginIndices(lines: string[]): number[] {
  const nonEmpty = lines.flatMap((line, i) => (line === "" ? [] : [i]));
  return [...new Set([...nonEmpty.slice(0, MARGIN_LINES), ...nonEmpty.slice(-MARGIN_LINES)])];
}

/** Signatures des lignes de marge présentes sur une majorité de pages. */
function findRepeatedMarginLines(linesPerPage: string[][]): Set<string> {
  const pageCount = linesPerPage.length;
  if (pageCount < MIN_PAGES_FOR_REPEAT) return new Set();

  const occurrences = new Map<string, number>();
  for (const lines of linesPerPage) {
    // Un Set par page : une ligne répétée deux fois sur la même page ne compte qu'une fois.
    const signatures = new Set(marginIndices(lines).map((i) => signature(lines[i]!)));
    for (const sig of signatures) occurrences.set(sig, (occurrences.get(sig) ?? 0) + 1);
  }

  const threshold = Math.max(MIN_PAGES_FOR_REPEAT, Math.ceil(pageCount * REPEAT_RATIO));
  return new Set([...occurrences].filter(([, count]) => count >= threshold).map(([sig]) => sig));
}

function removeMarginLines(lines: string[], repeated: Set<string>, removed: Map<string, string>): string[] {
  const toRemove = new Set(
    marginIndices(lines).filter((i) => {
      const sig = signature(lines[i]!);
      if (!repeated.has(sig)) return false;
      if (!removed.has(sig)) removed.set(sig, lines[i]!);
      return true;
    }),
  );
  return lines.filter((_, i) => !toRemove.has(i));
}

/**
 * Recolle deux morceaux de texte consécutifs. Si le premier finit par une
 * césure (« infor- ») et que le second commence par une minuscule (« mation »),
 * on supprime le tiret et l'espace. Limite connue : « porte-\nmonnaie » devient
 * « portemonnaie » — impossible à distinguer sans dictionnaire.
 */
export function joinText(left: string, right: string): string {
  if (left === "") return right;
  if (right === "") return left;
  if (HYPHENATED_END.test(left) && LOWERCASE_START.test(right)) return left.slice(0, -1) + right;
  return `${left} ${right}`;
}

/**
 * Regroupe les lignes d'une page en paragraphes. Un PDF ne connaît pas les
 * paragraphes, seulement des lignes positionnées ; on les devine :
 *  - une ligne vide termine un paragraphe ;
 *  - une puce ou une numérotation en commence un ;
 *  - une ligne nettement plus courte que les autres (dernière ligne d'un
 *    paragraphe, titre) termine un paragraphe si elle finit par une
 *    ponctuation forte ou si la suivante commence par une majuscule.
 */
export function buildParagraphs(lines: string[]): string[] {
  const fullLineLength = percentile(
    lines.filter((line) => line !== "").map((line) => line.length),
    0.8,
  );
  const isShort = (line: string) => line.length < fullLineLength * 0.8;

  const paragraphs: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") paragraphs.push(current);
    current = "";
  };

  lines.forEach((line, i) => {
    if (line === "") return flush();
    if (BULLET.test(line)) flush();

    current = joinText(current, line);

    const next = lines[i + 1];
    if (
      next !== undefined &&
      next !== "" &&
      isShort(line) &&
      (TERMINAL_PUNCTUATION.test(line) || UPPERCASE_START.test(next))
    ) {
      flush();
    }
  });
  flush();

  return paragraphs;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}
