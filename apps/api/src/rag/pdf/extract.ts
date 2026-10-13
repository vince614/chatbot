import { getDocumentProxy } from "unpdf";

import type { Page } from "../text/types.js";

/**
 * Un écart vertical entre deux lignes supérieur à ce multiple de l'interligne
 * habituel de la page signale un changement de paragraphe (ou un titre).
 */
const PARAGRAPH_GAP_RATIO = 1.4;

/**
 * Extrait le texte d'un PDF, page par page. Chaque page garde son numéro
 * (à partir de 1) : c'est ce qui permettra de citer « page 12 » plus tard.
 *
 * Un PDF ne contient pas de paragraphes, seulement des fragments de texte
 * positionnés. pdf.js nous dit où finit chaque ligne (hasEOL) et à quelle
 * hauteur elle se trouve : un interligne anormalement grand devient une
 * ligne vide, que le nettoyage interprétera comme une fin de paragraphe.
 *
 * Seul le texte réel est récupéré : un PDF scanné (des images de pages)
 * donne des pages vides, il faudrait de l'OCR pour le lire.
 */
export async function extractPages(pdfBytes: Uint8Array): Promise<Page[]> {
  // pdf.js transfère le buffer qu'on lui donne : on lui passe une copie.
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  try {
    const pages: Page[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const { items } = await page.getTextContent();
      pages.push({ pageNumber, text: linesToText(toLines(items)) });
      page.cleanup();
    }
    return pages;
  } finally {
    // Libère la mémoire et le worker pdf.js associés à ce document.
    await pdf.loadingTask.destroy();
  }
}

interface Line {
  text: string;
  /** Ordonnée de la ligne (en points, l'origine est en bas de la page). */
  y: number;
}

/** Ce qui nous intéresse dans un fragment de texte pdf.js. */
interface TextItem {
  str: string;
  hasEOL: boolean;
  /** Matrice [a, b, c, d, x, y] : position du fragment. */
  transform: number[];
}

function isTextItem(item: object): item is TextItem {
  return "str" in item;
}

/** Regroupe les fragments en lignes, grâce au drapeau hasEOL. */
function toLines(items: object[]): Line[] {
  const lines: Line[] = [];
  let text = "";
  let y: number | undefined;

  for (const item of items.filter(isTextItem)) {
    if (item.str !== "") {
      y ??= item.transform[5];
      text += item.str;
    }
    if (item.hasEOL && y !== undefined) {
      lines.push({ text, y });
      text = "";
      y = undefined;
    }
  }
  if (y !== undefined) lines.push({ text, y });

  return lines;
}

/** Assemble les lignes en insérant une ligne vide là où l'interligne est anormal. */
function linesToText(lines: Line[]): string {
  const gaps = lines.slice(1).map((line, i) => lines[i]!.y - line.y);
  const usualGap = median(gaps.filter((gap) => gap > 0));

  return lines
    .map((line, i) => {
      const gap = i === 0 ? 0 : lines[i - 1]!.y - line.y;
      const startsParagraph = usualGap > 0 && gap > usualGap * PARAGRAPH_GAP_RATIO;
      return (startsParagraph ? "\n" : "") + line.text;
    })
    .join("\n");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
