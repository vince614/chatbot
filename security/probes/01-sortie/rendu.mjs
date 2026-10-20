// Étape 1 (OWASP LLM05) — sonde DÉTERMINISTE du rendu.
//
// On rend le VRAI composant de l'application (apps/web/src/chat/MessageBubble.tsx)
// avec une réponse d'assistant piégée, et on inspecte le HTML produit. Aucun
// modèle, aucun réseau : même entrée, même sortie, à chaque exécution.
//
// Usage (depuis chatbot/) : npx tsx --tsconfig apps/web/tsconfig.json security/probes/01-sortie/rendu.mjs
// (tsx sait importer le composant .tsx depuis ce fichier JavaScript.)
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageBubble } from "../../../apps/web/src/chat/MessageBubble";
import { CHARGES, LEGITIMES, REPONSE } from "./charges.mjs";

const html = renderToStaticMarkup(
  createElement(MessageBubble, { message: { role: "assistant", content: REPONSE }, streaming: false }),
);

console.log("=== HTML produit par MessageBubble ===");
// Une balise par ligne : plus lisible qu'un seul bloc.
console.log(html.replace(/(<p>|<link )/g, "\n$1"));
console.log("\n=== Verdict par vecteur ===");

let failures = 0;
for (const charge of CHARGES) {
  const vulnerable = charge.vulnerable(html);
  if (vulnerable) failures += 1;
  console.log(`${vulnerable ? "VULNERABLE" : "bloque    "}  ${charge.id.padEnd(16)} ${charge.titre}`);
}
// react-markdown ajoute un <link rel=preload> par image : une requête de plus, même avant le <img>.
const preload = /<link[^>]*rel="preload"[^>]*href="http/i.test(html);
if (preload) failures += 1;
console.log(`${preload ? "VULNERABLE" : "bloque    "}  ${"preload-image".padEnd(16)} <link rel=preload> vers une image distante`);

console.log("\n=== Témoins positifs (doivent rester fonctionnels) ===");
const legit = renderToStaticMarkup(
  createElement(MessageBubble, {
    message: { role: "assistant", content: LEGITIMES.markdown, sources: LEGITIMES.sources },
    streaming: false,
  }),
);
for (const attendu of LEGITIMES.attendus) {
  const ok = attendu.ok(legit);
  if (!ok) failures += 1;
  console.log(`${ok ? "fonctionne" : "CASSE     "}  ${attendu.id}`);
}

console.log(`\n${failures === 0 ? "OK : aucun vecteur ne passe, rien de légitime n'est cassé." : `${failures} problème(s).`}`);
process.exitCode = failures === 0 ? 0 : 1;
