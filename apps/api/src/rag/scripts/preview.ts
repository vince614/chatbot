// npm run rag:preview -- <fichier.pdf> [--short]
// Affiche les chunks d'un PDF tels qu'ils seraient ingérés. N'écrit rien en base.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { PDF_DIR } from "../config.js";
import { splitPdf } from "../document.js";

const SHORT_PREVIEW_CHARS = 200;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { short: { type: "boolean", default: false } },
  });

  const arg = positionals[0];
  if (arg === undefined) {
    console.error("Usage : npm run rag:preview -- <fichier.pdf> [--short]");
    process.exitCode = 1;
    return;
  }

  // « mon.pdf » suffit si le fichier est dans data/pdfs/.
  const file = existsSync(arg) ? arg : path.join(PDF_DIR, arg);
  const started = performance.now();
  const { pageCount, chunks, removedMarginLines } = await splitPdf(await readFile(file));
  const duration = Math.round(performance.now() - started);

  for (const chunk of chunks) {
    const pages = chunk.pageStart === chunk.pageEnd ? `p. ${chunk.pageStart}` : `p. ${chunk.pageStart}–${chunk.pageEnd}`;
    console.log(`\n━━ Chunk #${chunk.index} · ${pages} · ${chunk.tokenCount} tokens ━━`);
    console.log(
      values.short && chunk.content.length > SHORT_PREVIEW_CHARS
        ? `${chunk.content.slice(0, SHORT_PREVIEW_CHARS)}…`
        : chunk.content,
    );
  }

  const tokens = chunks.map((c) => c.tokenCount);
  console.log(`\n━━ Résumé : ${path.basename(file)} ━━`);
  console.log(`Pages            : ${pageCount}`);
  console.log(`Chunks           : ${chunks.length}`);
  if (chunks.length > 0) {
    const average = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
    console.log(`Tokens / chunk   : min ${Math.min(...tokens)} · moy ${average} · max ${Math.max(...tokens)}`);
  }
  console.log(`En-têtes/pieds   : ${removedMarginLines.length === 0 ? "aucun détecté" : ""}`);
  for (const line of removedMarginLines) console.log(`  - « ${line} »`);
  console.log(`Durée            : ${duration} ms`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
