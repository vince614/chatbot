# Sondes de sécurité (jour 5)

Chaque sonde montre un comportement **avant** la correction, puis **après**,
avec une charge inoffensive : un marqueur en console (`SONDE-…`), une chaîne
repère (`TEST-INJECTION`), ou une requête vers le serveur témoin local.
Le récapitulatif risque / correction / preuve est dans [`../SECURITE.md`](../SECURITE.md).

## Outils communs (`lib/`)

| Fichier | Rôle |
| --- | --- |
| `witness.mjs` | Serveur « attaquant » sur `127.0.0.1:9999` : journalise toute requête dans `out/witness.log`. |
| `navigateur.mjs` | Lance un Chromium sans interface (Chrome ou Brave), ouvre une page, exécute un script de sonde comme depuis la console, et rapporte console, requêtes réseau et DOM. Sans dépendance : protocole DevTools via le `WebSocket` de Node 22. |

## Étape 1 — Sortie maîtrisée (LLM05) : `01-sortie/`

```bash
# rendu déterministe du vrai composant MessageBubble
npx tsx --tsconfig apps/web/tsconfig.json security/probes/01-sortie/rendu.mjs

# rendu réel dans le navigateur (npm run dev lancé)
node security/probes/lib/witness.mjs &          # le témoin
node security/probes/lib/navigateur.mjs http://localhost:5173 security/probes/01-sortie/navigateur.js
cat security/probes/out/witness.log              # vide = aucune fuite
```

`navigateur.js` peut aussi se coller tel quel dans la console de l'onglet du chatbot.
Résultats enregistrés : `avant.txt`, `apres.txt`, `avant-navigateur.txt`, `apres-navigateur.txt`.

## Étape 2 — CSP et en-têtes (LLM05) : `02-csp/`

```bash
npm run build -w apps/web
(cd apps/web && npx vite preview)               # http://localhost:4173, avec la CSP
node security/probes/lib/navigateur.mjs http://localhost:4173 security/probes/02-csp/navigateur.js
node security/probes/lib/navigateur.mjs http://localhost:4173 security/probes/02-csp/fonctionnel.js 10000
curl -sI http://localhost:4173/ ; curl -sI http://127.0.0.1:3000/api/health
```

`navigateur.js` injecte directement dans la page (comme si le rendu avait été
contourné) un script inline, un `onerror`, une image et un `fetch` vers le
témoin. `fonctionnel.js` envoie un vrai message : la page doit marcher sous CSP.
Résultats : `avant.txt`, `apres.txt`, `apres-fonctionnel.txt`.

## Étape 3 — Documents traités comme données (LLM01) : `03-injection/`

```bash
./security/probes/03-injection/setup.sh          # génère, dépose, ACL tech, ingère
cd apps/api
npx tsx --conditions=development ../../security/probes/03-injection/verrou.mts      # déterministe, sans réseau
npx tsx --conditions=development ../../security/probes/03-injection/sonde.mts 1     # modèle de l'app
PROBE_MODEL=claude-haiku-5-5 npx tsx --conditions=development ../../security/probes/03-injection/sonde.mts 2
PROBE_SET=limites npx tsx --conditions=development ../../security/probes/03-injection/sonde.mts
cd ../.. && ./security/probes/03-injection/setup.sh clean   # PDF, ACL et base restaurés
```

`sonde.mts` rejoue la chaîne de `/chat` (mode tool, serveur MCP de bruno) avec
un faux outil `envoyer_notification` qui écrit `SONDE-EFFET-DE-BORD` s'il est
exécuté. `verrou.mts` remplace le modèle par un modèle « compromis » qui obéit
toujours : il teste le code, pas le modèle. Une pause de 21 s sépare les
questions (quota Voyage : 3 requêtes/min ; `PROBE_PAUSE_MS` pour la changer).

## Étape 4 — Prompt système et logs (LLM07, LLM02) : `04-prompt-logs/`

```bash
node security/probes/04-prompt-logs/sonde.mjs     # API de test sur :3001, scénario, fouille du log
cd apps/api
npx tsx --conditions=development ../../security/probes/04-prompt-logs/prompt-statique.mts
npx tsx --conditions=development ../../security/probes/04-prompt-logs/erreurs.mts
```

`sonde.mjs` lance sa propre API (port 3001, logs dans `out/api-3001.log`) et
n'affiche jamais un secret : seulement son nom et « trouvé / absent ».
