// Étape 4 (OWASP LLM02) — sonde DÉTERMINISTE des logs d'erreur.
//
// Sur le chemin normal, les logs ne contiennent que des métadonnées (sonde.mjs
// le prouve). Mais un log d'ERREUR recopie souvent le message de l'exception,
// et ces messages citent volontiers la donnée fautive :
//   - Postgres : invalid input syntax for type … : "<la valeur>" ;
//   - une API distante : le corps de sa réponse, qui peut reprendre l'entrée.
// On fait échouer un outil du serveur MCP (runTool, le vrai code) avec de tels
// messages, porteurs d'une chaîne repère, et on regarde ce qui part sur stderr.
//
// Usage (depuis chatbot/apps/api) :
//   npx tsx --conditions=development ../../security/probes/04-prompt-logs/erreurs.mts
import { runTool } from "../../../apps/mcp-server/src/tools/shared.js";

const MARKER = "SONDE-LOG-ERREUR question de bruno sur la prime";
const FAILURES = [
  new Error(`invalid input syntax for type tsquery: "${MARKER}"`),
  new Error(`Voyage a répondu HTTP 400 : {"detail":"Input '${MARKER}' is too long"}`),
  Object.assign(new Error(`400 {"type":"error","error":{"message":"messages.0.content: « ${MARKER} »"}}`), { status: 400 }),
];

// On capture stderr (le canal des logs du serveur MCP) au lieu de l'afficher.
const lines: string[] = [];
const original = console.error;
console.error = (...args: unknown[]) => void lines.push(args.join(" "));
for (const error of FAILURES) {
  await runTool("search_documents", "La recherche a échoué.", async () => {
    throw error;
  });
}
console.error = original;

let leaks = 0;
for (const line of lines) {
  const leaked = line.includes("SONDE-LOG-ERREUR");
  if (leaked) leaks += 1;
  console.log(`${leaked ? "FUITE " : "propre"}  ${line}`);
}
console.log(leaks === 0 ? "\nOK : les messages d'erreur sont journalisés sans la donnée qu'ils citent." : `\n${leaks}/${lines.length} log(s) d'erreur recopient la donnée.`);
process.exitCode = leaks === 0 ? 0 : 1;
