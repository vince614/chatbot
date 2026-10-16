import { joinText } from "./clean.js";
import type { Chunk, Page, TokenCounter } from "./types.js";

/**
 * Découpage d'un document nettoyé en chunks d'environ `targetTokens` tokens,
 * avec recouvrement. Fonctions pures : le compteur de tokens est injecté.
 *
 * Trois temps :
 *  1. on reconstitue la suite des paragraphes du document, en recollant ceux
 *     qu'un saut de page a coupés en deux ;
 *  2. on découpe chaque paragraphe en phrases (les « unités »), chacune
 *     connaissant ses pages ;
 *  3. on remplit des chunks avec ces unités, en coupant de préférence sur une
 *     fin de paragraphe, sinon sur une fin de phrase, et on fait démarrer
 *     chaque chunk par les dernières phrases du précédent.
 */

export interface ChunkOptions {
  countTokens: TokenCounter;
  /** Taille visée d'un chunk, en tokens. */
  targetTokens?: number;
  /** Part du chunk précédent répétée au début du suivant (0.15 = 15 %). */
  overlapRatio?: number;
}

/** Une coupure sur fin de paragraphe n'est retenue que si le chunk atteint cette part de la cible. */
const MIN_FILL_FOR_PARAGRAPH_CUT = 0.6;

const TERMINAL_PUNCTUATION = /[.!?:;…»"”)]$/;
const LOWERCASE_START = /^\p{Ll}/u;

/** Un paragraphe et les pages qu'il traverse. */
interface Paragraph {
  text: string;
  /** Début (en caractères) de chaque portion de page dans `text`, dans l'ordre. */
  pageOffsets: { offset: number; pageNumber: number }[];
}

/** Le plus petit morceau qu'on ne coupe pas : une phrase (ou un fragment de phrase géante). */
interface Unit {
  text: string;
  tokens: number;
  pageStart: number;
  pageEnd: number;
  /** Vrai si l'unité est la dernière de son paragraphe. */
  endsParagraph: boolean;
}

export function chunkPages(pages: Page[], options: ChunkOptions): Chunk[] {
  const target = options.targetTokens ?? 500;
  const overlap = Math.round(target * (options.overlapRatio ?? 0.15));
  const units = toParagraphs(pages).flatMap((p) => toUnits(p, target, options.countTokens));
  return assemble(units, target, overlap, options.countTokens);
}

// --- 1. Paragraphes du document ----------------------------------------------

/**
 * Enchaîne les paragraphes de toutes les pages. Si une page se termine sans
 * ponctuation forte et que la suivante commence par une minuscule, c'est la
 * même phrase coupée par le saut de page : on recolle.
 */
function toParagraphs(pages: Page[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const page of pages) {
    const texts = page.text.split("\n\n").filter((text) => text !== "");
    texts.forEach((text, i) => {
      const previous = paragraphs.at(-1);
      const continuesPrevious =
        i === 0 &&
        previous !== undefined &&
        !TERMINAL_PUNCTUATION.test(previous.text) &&
        LOWERCASE_START.test(text);

      if (continuesPrevious) {
        const joined = joinText(previous.text, text);
        previous.pageOffsets.push({ offset: joined.length - text.length, pageNumber: page.pageNumber });
        previous.text = joined;
      } else {
        paragraphs.push({ text, pageOffsets: [{ offset: 0, pageNumber: page.pageNumber }] });
      }
    });
  }

  return paragraphs;
}

// --- 2. Unités (phrases) ------------------------------------------------------

// Intl.Segmenter est intégré à Node : il connaît les règles de fin de phrase
// propres à chaque langue (abréviations, guillemets…).
const sentenceSegmenter = new Intl.Segmenter("fr", { granularity: "sentence" });

function toUnits(paragraph: Paragraph, target: number, countTokens: TokenCounter): Unit[] {
  const pageAt = (offset: number) =>
    paragraph.pageOffsets.findLast((p) => p.offset <= offset)?.pageNumber ?? paragraph.pageOffsets[0]!.pageNumber;

  const units: Unit[] = [];
  for (const { segment, index } of sentenceSegmenter.segment(paragraph.text)) {
    const text = segment.trim();
    if (text === "") continue;

    const pageStart = pageAt(index);
    const pageEnd = pageAt(index + segment.trimEnd().length - 1);
    for (const piece of splitOversized(text, target, countTokens)) {
      units.push({ text: piece, tokens: countTokens(piece), pageStart, pageEnd, endsParagraph: false });
    }
  }

  if (units.length > 0) units.at(-1)!.endsParagraph = true;
  return units;
}

/**
 * Une phrase plus longue qu'un chunk entier (tableau aplati, liste sans
 * ponctuation…) est découpée de force entre deux mots.
 */
function splitOversized(text: string, target: number, countTokens: TokenCounter): string[] {
  if (countTokens(text) <= target) return [text];

  const pieces: string[] = [];
  let current = "";
  let currentTokens = 0;
  for (const word of text.split(" ")) {
    const wordTokens = countTokens(` ${word}`);
    if (current !== "" && currentTokens + wordTokens > target) {
      pieces.push(current);
      current = "";
      currentTokens = 0;
    }
    current = current === "" ? word : `${current} ${word}`;
    currentTokens += wordTokens;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

// --- 3. Assemblage des chunks -------------------------------------------------

function assemble(units: Unit[], target: number, overlap: number, countTokens: TokenCounter): Chunk[] {
  const chunks: Chunk[] = [];
  const emit = (selected: Unit[]) => chunks.push(toChunk(chunks.length, selected, countTokens));

  /** Unités du chunk en cours ; les `overlapCount` premières viennent du chunk précédent (recouvrement). */
  let window: Unit[] = [];
  let overlapCount = 0;

  for (const unit of units) {
    // On ferme le chunk si l'unité le ferait déborder… à condition qu'il
    // contienne autre chose que le recouvrement (sinon on n'avancerait pas).
    while (window.length > overlapCount && sumTokens(window) + unit.tokens > target) {
      const cut = chooseCut(window, overlapCount, target);
      const emitted = window.slice(0, cut);
      emit(emitted);

      const tail = overlapTail(emitted, overlap);
      window = [...tail, ...window.slice(cut)];
      overlapCount = tail.length;
    }
    window.push(unit);
  }
  if (window.length > overlapCount) emit(window);

  return chunks;
}

/**
 * Où couper le chunk en cours ? Renvoie le nombre d'unités à émettre.
 * Préférence : après la dernière fin de paragraphe, si le chunk est alors
 * assez rempli. Sinon : après la dernière phrase (tout le chunk).
 */
function chooseCut(window: Unit[], overlapCount: number, target: number): number {
  let tokens = 0;
  let best = window.length;
  window.forEach((unit, i) => {
    tokens += unit.tokens;
    if (i >= overlapCount && unit.endsParagraph && tokens >= target * MIN_FILL_FOR_PARAGRAPH_CUT) best = i + 1;
  });
  return best;
}

/**
 * Dernières phrases du chunk émis, à répéter au début du suivant : on remonte
 * jusqu'à atteindre `overlap` tokens, sans jamais reprendre le chunk entier ni
 * une phrase qui doublerait le recouvrement visé.
 */
function overlapTail(emitted: Unit[], overlap: number): Unit[] {
  const tail: Unit[] = [];
  let tokens = 0;
  for (let i = emitted.length - 1; i > 0 && tokens < overlap; i--) {
    const unit = emitted[i]!;
    if (tokens + unit.tokens > overlap * 2) break;
    tail.unshift(unit);
    tokens += unit.tokens;
  }
  return tail;
}

function toChunk(index: number, units: Unit[], countTokens: TokenCounter): Chunk {
  // Deux phrases d'un même paragraphe sont séparées par une espace, deux
  // paragraphes par une ligne vide.
  const content = units
    .map((unit, i) => (i === 0 ? "" : units[i - 1]!.endsParagraph ? "\n\n" : " ") + unit.text)
    .join("");

  return {
    index,
    pageStart: Math.min(...units.map((u) => u.pageStart)),
    pageEnd: Math.max(...units.map((u) => u.pageEnd)),
    content,
    tokenCount: countTokens(content),
  };
}

function sumTokens(units: Unit[]): number {
  return units.reduce((total, unit) => total + unit.tokens, 0);
}
