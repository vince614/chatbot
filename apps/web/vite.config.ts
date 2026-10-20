import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Content-Security-Policy de la page : ce que le NAVIGATEUR accepte de
 * charger et d'exécuter, quel que soit le code qui le demande. C'est le
 * filet sous le rendu Markdown (safeUrls.ts) : si un jour du HTML passait le
 * rendu, il ne pourrait ni exécuter de script ni envoyer de requête ailleurs.
 *
 *  - script-src 'self' : seulement nos fichiers .js, aucun script inline ni
 *    gestionnaire onerror="…" ;
 *  - img-src 'self' data: : la même règle que safeUrls.ts, côté navigateur ;
 *  - connect-src 'self' : fetch (le flux SSE de /api/chat) vers nous seuls ;
 *  - style-src 'self' : nos feuilles de style (les style={…} de React passent
 *    par le DOM, pas par du CSS inline : ils restent permis) ;
 *  - object-src, base-uri, form-action, frame-ancestors : les portes moins
 *    connues (plugins, <base> qui détourne les chemins relatifs, formulaires
 *    vers l'extérieur, page affichée dans le cadre d'un autre site).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Les en-têtes usuels, valables aussi en développement. */
const SECURITY_HEADERS = {
  // Le navigateur ne devine pas le type d'un fichier : un .txt reste du texte, jamais un script.
  "X-Content-Type-Options": "nosniff",
  // Aucune URL de la page (ni ses paramètres) n'est transmise aux sites liés.
  "Referrer-Policy": "no-referrer",
  // Équivalent ancien de frame-ancestors 'none', pour les navigateurs qui l'ignorent.
  "X-Frame-Options": "DENY",
  // Une fenêtre ouverte depuis la page ne peut pas la manipuler (window.opener).
  "Cross-Origin-Opener-Policy": "same-origin",
  // Des capteurs dont un chatbot n'a pas besoin.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Pas de CSP en développement : Vite y injecte un script inline (le
    // préambule de React Refresh) que script-src 'self' refuserait. La CSP
    // s'applique au build, servi par « vite preview » (et par tout serveur
    // de production, qui devra reprendre ces en-têtes).
    headers: SECURITY_HEADERS,
    // Tout appel à /api/* est relayé vers Fastify. Le front ne connaît
    // ni l'URL du fournisseur LLM ni sa clé.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  preview: {
    port: 4173,
    headers: { ...SECURITY_HEADERS, "Content-Security-Policy": CONTENT_SECURITY_POLICY },
    // Le même relais vers l'API que le serveur de développement.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
