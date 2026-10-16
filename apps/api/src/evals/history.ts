// npm run eval:history [-- --last 10]
// L'évolution des scores, un run complet par ligne (evals/history.jsonl).
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { CRITERIA, formatTotal, HISTORY_FILE, type HistoryLine } from "./scoring.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { last: { type: "string", default: "20" } } });
  let text = "";
  try {
    text = await readFile(HISTORY_FILE, "utf8");
  } catch {
    console.log("Historique vide : lance d'abord « npm run eval -- --user <id> ».");
    return;
  }
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as HistoryLine)
    .slice(-Number(values.last));

  const columns: [string, number, (l: HistoryLine) => string][] = [
    ["run", 19, (l) => l.run],
    ["rag", 10, (l) => l.config.rag ?? "always"],
    ["recherche", 9, (l) => l.config.recherche],
    ["util.", 6, (l) => l.config.utilisateur],
    ["modèle", 16, (l) => l.config.modele],
    ["juge", 17, (l) => `${l.config.juge} ${l.config.grille}`],
    ["k", 2, (l) => String(l.config.k)],
    ["chunk", 5, (l) => String(l.config.tokens_par_chunk)],
    ...CRITERIA.map((c): [string, number, (l: HistoryLine) => string] => [c, 10, (l) => formatTotal(l.scores[c])]),
    ["commit", 16, (l) => l.config.commit],
  ];
  console.log(columns.map(([name, width]) => name.padEnd(width)).join("  "));
  for (const line of lines) {
    console.log(columns.map(([, width, read]) => read(line).padEnd(width)).join("  "));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
