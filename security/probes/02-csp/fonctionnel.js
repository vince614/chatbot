// Étape 2 — témoin positif : l'application fonctionne-t-elle encore sous CSP ?
// Envoie un vrai message (une salutation : pas de recherche, un seul appel
// modèle). Attendu : une réponse affichée, AUCUNE violation CSP en console.
(() => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const setValue = (element, proto, value) => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  return (async () => {
    const select = document.querySelector("select");
    if (select && select.value !== "bruno") setValue(select, HTMLSelectElement.prototype, "bruno");
    await pause(800);
    setValue(document.querySelector("textarea"), HTMLTextAreaElement.prototype, "Bonjour ! Réponds juste « bonjour ».");
    await pause(200);
    document.querySelector("button[type=submit]").click();
    console.log("[sonde-02] vrai message envoyé");
  })();
})();
