// Étape 4 (OWASP LLM07) — le prompt système contient-il quelque chose à cacher ?
//
// Un prompt système finit toujours par fuiter (drapeau de debug, extraction par
// le modèle, journal mal réglé). La seule protection solide est donc qu'il ne
// contienne RIEN de sensible. On l'inspecte tel que le code le construit.
//
// Usage (depuis chatbot/apps/api) :
//   npx tsx --conditions=development ../../security/probes/04-prompt-logs/prompt-statique.mts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TOOL_SYSTEM_PROMPT } from "../../../apps/api/src/chat/search-results.js";
import { RAG_SYSTEM_PROMPT } from "../../../apps/api/src/rag/prompt.js";

const API = fileURLToPath(new URL("../../../apps/api/", import.meta.url));
const env = Object.fromEntries(
  readFileSync(`${API}.env`, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
const tokens = Object.keys(JSON.parse(readFileSync(`${API}data/mcp-tokens.json`, "utf8")) as Record<string, string>);
const acl = JSON.parse(readFileSync(`${API}data/pdfs/acl.json`, "utf8")) as Record<string, string[]>;
const users = JSON.parse(readFileSync(`${API}data/users.json`, "utf8")) as { id: string; groupes: string[] }[];

const sensitive: [string, string | undefined][] = [
  ["clé du LLM", env["LLM_API_KEY"]],
  ["clé d'embeddings", env["EMBEDDING_API_KEY"]],
  ["URL de la base", env["DATABASE_URL"]],
  ...tokens.map((t, i): [string, string] => [`jeton MCP n°${i + 1}`, t]),
  ...Object.keys(acl).map((file): [string, string] => [`nom de document (${file})`, file]),
  ...users.map((u): [string, string] => [`identifiant d'utilisateur (${u.id})`, u.id]),
];
const groups = [...new Set(users.flatMap((u) => u.groupes))];

let findings = 0;
for (const [mode, prompt] of [["tool", TOOL_SYSTEM_PROMPT], ["always", RAG_SYSTEM_PROMPT]] as const) {
  writeFileSync(fileURLToPath(new URL(`./prompt-systeme-${mode}.txt`, import.meta.url)), `${prompt}\n`);
  console.log(`=== Prompt système, mode ${mode} : ${prompt.length} caractères (copie : prompt-systeme-${mode}.txt) ===`);
  for (const [name, value] of sensitive) {
    if (value && prompt.includes(value)) {
      findings += 1;
      console.log(`TROUVÉ  ${name}`);
    }
  }
  // Un groupe en mot entier (« tech » ne doit pas matcher « technique »).
  for (const group of groups) {
    if (new RegExp(`\\b${group}\\b`, "i").test(prompt)) {
      findings += 1;
      console.log(`TROUVÉ  groupe « ${group} »`);
    }
  }
  if (/(api[_ -]?key|password|mot de passe|token|jeton|sk-[a-z0-9])/i.test(prompt)) {
    findings += 1;
    console.log("TROUVÉ  un terme de secret (clé, mot de passe, jeton)");
  }
}
console.log(findings === 0 ? "\nOK : aucun secret, aucun nom de document, de groupe ni d'utilisateur dans le prompt système." : `\n${findings} élément(s) sensible(s).`);
process.exitCode = findings === 0 ? 0 : 1;
