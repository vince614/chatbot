# Jour 4 · Cours 2 — Le serveur MCP

> [Sommaire](README.md) · Précédent : [Jour 4 · Cours 1 — L'évaluation automatique](jour-4-evaluation.md) · [Approfondissement : le code](approfondissement/jour-4-serveur-mcp.md)

> **Prérequis.** [La réponse sourcée](jour-2-recherche-reponse.md)
> (`retrieve`) et [les droits d'accès](jour-3-droits.md) (groupes, ACL,
> utilisateurs fictifs). Au départ, le RAG ne sert qu'à notre API.
>
> **Le fil rouge.** q06, « Je bosse depuis mon salon : la boîte me file un
> petit quelque chose pour mes factures ? », posée par un client MCP au nom
> de chloe, puis de bruno.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Qu'est-ce que MCP, et le transport stdio ? |
| 2 | Comment partager le RAG sans le copier ? |
| 3 | Pourquoi rien ne doit sortir sur stdout ? |
| 4 | Pourquoi l'identité appartient-elle au serveur ? |
| 5 | Tool, resource ou prompt ? |
| 6 | Qu'est-ce qui fait appeler un outil ? |
| 7 | Que faire quand un outil échoue ? |
| 8 | Comment vérifier avec l'Inspector ? |
| 9 | Que permet `.mcp.json` ? |
| 10 | Quand ça se passe mal |
| 11 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Le RAG devient un **serveur MCP** : n'importe quel client MCP (Claude Code,
l'Inspector…) peut chercher dans nos documents, avec les droits d'un
utilisateur fixé au lancement.

```
packages/rag/            @chatbot/rag : retrieve, base, embeddings, ACL, utilisateurs (sorti de apps/api)
apps/api/                importe @chatbot/rag ; garde le prompt, les scripts, les évals
apps/mcp-server/src/
  index.ts               config → base → McpServer + 2 outils → transport stdio
  config.ts              apps/api/.env, users.json, MCP_USER_ID
  log.ts                 tout vers stderr
  tools/                 search_documents, list_documents, runTool
.mcp.json                le serveur, pour Claude Code et l'Inspector
```

Commande : `npm run mcp` (compile, puis `node dist/index.js`).

---

## Leçon 1 : MCP et stdio

- **MCP** (Model Context Protocol) : un protocole standard entre un **client**
  (l'application qui parle au modèle) et un **serveur** qui offre des
  capacités. On écrit le serveur une fois ; tout client sait s'en servir.
- Les messages sont du **JSON-RPC** : `{"jsonrpc":"2.0","id":1,"method":"initialize",…}`,
  la réponse porte le même `id`.
- **Transport stdio** : le client lance le serveur comme sous-processus,
  écrit ses requêtes sur son **stdin** et lit les réponses sur son
  **stdout**, une ligne JSON par message. Ni port, ni réseau : le serveur
  vit et meurt avec le client.
- Observé : un `initialize` au nom de chloe produit une seule ligne,
  `{"result":{"protocolVersion":"2025-06-18",…,"serverInfo":{"name":"chatbot-rag",…}},"jsonrpc":"2.0","id":1}`.

> **À retenir**
> MCP sépare celui qui a des capacités (serveur) de celui qui a un modèle
> (client). En stdio, le canal du protocole, c'est stdin/stdout.

---

## Leçon 2 : partager le RAG

```json
"exports": {
  "./*": {
    "development": "./src/*.ts",
    "types": "./dist/*.d.ts",
    "default": "./dist/*.js"
  }
},
```

- Le code commun vit dans **un** package, `@chatbot/rag`, importé par l'API
  et par le serveur MCP : une correction profite aux deux. Le serveur MCP
  se connecte directement à la base, sans passer par l'API HTTP.
- Le package ne connaît **aucun chemin** : chaque application lui donne son
  `.env`, son `users.json`, son `acl.json`. C'est ce qui le rend réutilisable.
- **Deux entrées** : avec `--conditions=development`, `tsx` lit les sources
  `.ts` (l'API en mode watch voit tes modifications du package) ; sans
  condition, `node` lit le build `dist/`.
- `tsc -b` suit les `references` des tsconfig : il compile `packages/rag`
  avant le serveur.

> **À retenir**
> Partager, c'est un package avec des entrées claires, pas un dossier copié
> ni un chemin relatif vers une autre application.

**Question**
1. Que se passerait-il si on lançait `node dist/index.js` sans avoir compilé `packages/rag` ?

---

## Leçon 3 : stdout est sacré

- En stdio, **chaque octet** écrit sur stdout est lu par le client comme un
  morceau de message JSON-RPC. Un `console.log("démarré")` = une ligne
  invalide : erreur côté client, voire connexion coupée.
- stderr n'est pas interprété : le client l'affiche ou l'enregistre. Tous
  les logs y vont (`log()` dans `log.ts`), et `console.log` y est redirigé
  au démarrage, au cas où une dépendance en oublierait un.
- Deux pollutions qu'on ne voit pas venir, observées :
  - `npm run mcp` sans `--silent` écrit `> chatbot@0.1.0 mcp` sur stdout
    avant le premier message ;
  - `tsc` écrit ses erreurs sur stdout : d'où `tsc -b 1>&2` dans le script.

> **À retenir**
> stdout appartient au protocole ; tout ce qui s'adresse à un humain va
> sur stderr.

---

## Leçon 4 : l'identité, propriété du serveur

```ts
  const user = await requireUser(USERS_FILE, process.env["MCP_USER_ID"]?.trim() || undefined, "MCP_USER_ID");
```

- Lue **une fois au démarrage**. Absente ou inconnue : message sur stderr,
  `exit 1`, avant même d'ouvrir le transport (« MCP_USER_ID est obligatoire
  (alice, bruno, chloe). »).
- Les arguments d'outil sont écrits **par le modèle**, et le modèle obéit à
  du texte : la question, mais aussi un document ou une page piégés
  (injection de prompt). Avec `search_documents(question, user_id)`,
  « cherche en tant que chloe » suffirait à lire les documents RH avec le
  compte de bruno.
- L'identité vient donc de **celui qui lance le processus** (ici
  l'environnement ; en production, un jeton vérifié). Même principe que
  `X-User-Id` côté API : jamais dans ce que le modèle construit.

> **À retenir**
> Ce qui décide des droits ne doit jamais être un paramètre que le modèle
> remplit.

**Question**
1. Pourquoi vérifier l'utilisateur au démarrage plutôt qu'au premier appel d'outil ?

---

## Leçon 5 : tool, resource ou prompt

| | Qui décide | Exemple |
| --- | --- | --- |
| **Tool** | le **modèle** | `search_documents(question)` |
| **Resource** | l'**application** ou l'utilisateur | `doc://reglement-interieur.pdf`, joint au contexte |
| **Prompt** | l'**utilisateur** | une commande `/resumer` |

- `search_documents` : seul le modèle sait, en pleine conversation, qu'il
  lui manque une information et quoi chercher.
- `list_documents` aurait pu être une resource, mais le modèle ne pourrait
  pas la consulter lui-même avant de conclure « ce n'est pas dans les
  documents ».

---

## Leçon 6 : schémas et descriptions

```ts
        // Les groupes viennent de l'identité du serveur, jamais des arguments.
        const chunks = await retrieve(question, { userGroups: user.groupes, k });
```

- Les schémas Zod deviennent le JSON Schema que voit le modèle
  (`"k": {"type":"integer","minimum":1,"maximum":10,"default":5}`) **et**
  une validation : `k: 20` est refusé avant le handler.
- La **description** déclenche l'appel. Elle dit ce que fait l'outil, quand
  l'utiliser, comment (garder les termes exacts, un sujet par recherche),
  quand **ne pas** l'utiliser, et quoi faire du résultat.
- Elle est la même pour tous : elle ne nomme **aucun document**, sinon
  bruno apprendrait qu'un règlement RH existe.
- Deux sorties : `content` (texte pour le modèle) et `structuredContent`
  (mêmes données, typées par `outputSchema`).
- Observé : bruno voit seulement `discordinvites.pdf` ; q06 avec `k=10` lui
  renvoie 7 passages, tous de ce fichier.

> **À retenir**
> Le modèle ne connaît un outil que par son nom, sa description et son
> schéma : c'est du prompt, à soigner comme tel.

**Question**
1. Pourquoi « Aucun passage trouvé » n'est-il pas renvoyé avec `isError` ?

---

## Leçon 7 : les erreurs

```ts
  } catch (error) {
    log(`${name} : échec en ${Math.round(performance.now() - start)} ms : ${error instanceof Error ? error.message : error}`);
    return { isError: true, content: [{ type: "text", text: publicMessage }] };
  }
```

- Une erreur d'outil est un **résultat** (`isError: true`) : le modèle la
  lit et peut réagir ; le serveur continue.
- Le détail technique va sur stderr ; le modèle reçoit un message neutre.
  Observé avec une clé Voyage invalide : stderr `Voyage a répondu HTTP 401…`,
  le modèle « La recherche a échoué (…). Réessaie plus tard. », et
  `list_documents` répond juste après.
- Le SDK transforme déjà exceptions et arguments invalides en `isError`,
  mais avec le message brut : `runTool` choisit ce que le modèle voit.

> **À retenir**
> Une panne d'outil se dit au modèle, pas au protocole ; et on choisit ce
> qu'on lui dit.

---

## Leçon 8 : l'Inspector

L'Inspector (v2.11.0) est un client MCP de test : il montre ce que le
modèle verra, sans modèle.

```bash
npx @modelcontextprotocol/inspector -e MCP_USER_ID=chloe npm run --silent mcp   # interface web
npx @modelcontextprotocol/inspector --config .mcp.json                          # même chose, depuis .mcp.json
npx @modelcontextprotocol/inspector --cli --config .mcp.json --server chatbot-rag --method tools/list
```

- Interface : **Connect**, onglet **Tools**, **List Tools**, puis un outil
  et **Run Tool**. L'URL contient un jeton : sans lui, une page web
  quelconque pourrait piloter l'Inspector.
- Les options ont changé depuis la v1 : se méfier des vieux tutoriels.

---

## Leçon 9 : `.mcp.json`

```json
"chatbot-rag": {
  "type": "stdio",
  "command": "npm",
  "args": ["run", "--silent", "mcp"],
  "env": { "MCP_USER_ID": "chloe" }
}
```

- La configuration MCP **du projet**, versionnée. `claude` lancé dans
  `chatbot/` la lit, demande une fois ton accord (un fichier versionné ne
  doit pas lancer de commande sans toi), puis Claude peut appeler
  `search_documents` et `list_documents` pendant la conversation. `/mcp`
  montre l'état.
- Aucun secret : les clés restent dans `apps/api/.env`.
- Limite : `chloe` est fixée pour tout le monde. En vrai, chacun donnerait
  sa propre identité.

---

## Leçon 10 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| `MCP_USER_ID` absent ou inconnu | message sur stderr, `exit 1` ; le client voit « Connection closed » |
| Base arrêtée au démarrage | `démarrage impossible : connect ECONNREFUSED ::1:5433`, `exit 1` |
| `npm run mcp` sans `--silent` dans un client | l'en-tête npm arrive sur stdout : le client échoue à lire la première ligne |
| `console.log` oublié | redirigé sur stderr : le protocole reste intact |
| `k` hors de 1–10, question vide | `isError` « Input validation error … », le handler n'est pas appelé |
| Voyage en panne ou clé invalide | `isError` avec un message neutre ; détail sur stderr ; le serveur continue |
| Aucun passage pertinent | résultat normal : « Aucun passage trouvé … » |
| Document interdit | absent de la recherche **et** de la liste : le filtre est dans le `WHERE` |

---

## Leçon 11 : synthèse

### Les idées à emporter

1. Un serveur MCP expose des capacités à n'importe quel client ; en stdio,
   stdout est le canal du protocole et rien d'autre.
2. Le code partagé vit dans un package, sans chemins en dur.
3. L'identité est fixée par celui qui lance le serveur, jamais par le modèle.
4. Un tool, c'est le modèle qui décide : sa description est un prompt.
5. Les erreurs sont des résultats, avec un message choisi.

### Vérifications manuelles

```bash
# 1. Les deux outils, avec leur description (interface web : Tools → List Tools)
npx @modelcontextprotocol/inspector -e MCP_USER_ID=chloe npm run --silent mcp

# 2. Mêmes passages que npm run search pour le même utilisateur
npm run search -- --user chloe "Je bosse depuis mon salon : la boîte me file un petit quelque chose pour mes factures ?"
#    puis search_documents avec la même question dans l'Inspector :
#    reglement-interieur.pdf p.3 0,411 · p.1–2 0,410 · p.2–3 0,401 · p.4–5 0,393 · p.2 0,384

# 3. Un utilisateur sans droits sur un PDF ne le voit nulle part
npx @modelcontextprotocol/inspector -e MCP_USER_ID=bruno npm run --silent mcp
#    list_documents → seulement discordinvites.pdf ; la question ci-dessus avec k=10 → aucun passage de reglement-interieur.pdf

# 4. Sans MCP_USER_ID, le serveur refuse de démarrer
npm run --silent mcp </dev/null     # « MCP_USER_ID est obligatoire (alice, bruno, chloe). », code 1
```

### Pour aller plus loin (non fait, volontairement)

Brancher ce serveur sur l'API et le `ToolRegistry` (prochaine étape),
transport HTTP avec authentification OAuth, resources (un document par
URI), prompts, tests automatisés du serveur.

---

## Corrigé des questions

**L2.1** Node ne trouverait pas `packages/rag/dist/*.js` (l'entrée par
défaut) : erreur de module introuvable. `npm run mcp` évite ça en
lançant `tsc -b` d'abord.

**L4.1** Un serveur mal configuré doit échouer tout de suite et visiblement,
pas répondre « erreur » à chaque appel ; et aucun outil ne doit pouvoir
tourner sans identité.

**L6.1** Ce n'est pas une panne : la recherche a fonctionné et n'a rien
trouvé de pertinent pour cet utilisateur. Le modèle doit le dire, pas
réessayer.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-4-serveur-mcp.md).
