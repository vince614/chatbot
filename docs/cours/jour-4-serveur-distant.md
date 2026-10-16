# Jour 4 · Cours 4 — Le serveur MCP distant

> [Sommaire](README.md) · Précédent : [Jour 4 · Cours 3 — L'API, client MCP](jour-4-client-mcp.md) · [Approfondissement : le code](approfondissement/jour-4-serveur-distant.md)

> **Prérequis.** [Le serveur MCP](jour-4-serveur-mcp.md) (stdio, identité
> fixée par `MCP_USER_ID`) et [l'API, client MCP](jour-4-client-mcp.md) (un
> sous-processus par utilisateur, `McpPool`). Au départ, le serveur ne parle
> qu'en stdio, et seul celui qui le lance peut s'en servir.
>
> **Le fil rouge.** chloe et bruno appellent le **même** processus serveur
> en HTTP, chacun avec son jeton. bruno essaie ensuite de parler dans la
> session de chloe.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Que prouve un même serveur sur deux transports ? |
| 2 | Pourquoi Streamable HTTP remplace-t-il l'ancien transport SSE ? |
| 3 | Qu'est-ce qu'une session MCP ? |
| 4 | Pourquoi l'identité doit-elle venir de chaque requête ? |
| 5 | Comment vérifier un jeton sans rien laisser deviner ? |
| 6 | Que prévoit la spécification (OAuth 2.1) ? |
| 7 | Comment le client suit-il ? |
| 8 | Les deux transports donnent-ils les mêmes résultats ? |
| 9 | Quand ça se passe mal |
| 10 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Le serveur MCP accepte `--transport http` : un seul processus, sur
`http://127.0.0.1:3100/mcp`, sert tous les utilisateurs, chacun identifié
par un jeton. L'API sait s'y connecter à la place du stdio.

```
apps/mcp-server/src/
  server.ts                createRagServer(context) : McpServer + les 2 outils (inchangés)
  transports/stdio.ts      l'ancien mode
  transports/http.ts       /mcp, /health, Host/Origin, jeton, sessions
  transports/tool-log.ts   une ligne par appel d'outil (utilisateur, outil, durée, session)
  auth.ts                  jeton → utilisateur, en temps constant
packages/rag/src/mcp-tokens.ts   lecture et validation de data/mcp-tokens.json
apps/api/src/mcp/pool.ts         stdio ou http (MCP_TRANSPORT), pannes HTTP
apps/api/data/mcp-tokens.json    { "<jeton>": "chloe", … } — ignoré par git (modèle : .example.json)
```

Commandes : `npm run --silent mcp -- --transport http`, puis
`MCP_TRANSPORT=http` côté API.

---

## Leçon 1 : un serveur, deux transports

```ts
export function createRagServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "chatbot-rag", version: "0.1.0" });
  registerSearchDocuments(server, context);
  registerListDocuments(server, context);
  return server;
}
```

- MCP a deux couches : le **protocole** (JSON-RPC, `initialize`,
  `tools/call`, les primitives) et le **transport** (comment les octets
  voyagent). `McpServer` ne connaît que la première.
- stdio et HTTP font la même chose : `server.connect(transport)`. Les fichiers
  des outils n'ont pas changé d'une ligne.
- Ce qui change avec le transport, c'est **d'où vient l'utilisateur** :
  l'environnement en stdio, le jeton en HTTP. Le `context` des outils, lui,
  a la même forme.

> **À retenir**
> Le protocole et le transport sont indépendants : un outil bien écrit ne sait
> pas comment la question lui est arrivée.

---

## Leçon 2 : Streamable HTTP plutôt que SSE

| | Ancien transport SSE (spec 2024-11-05) | Streamable HTTP (spec 2025-03-26 et suivantes) |
| --- | --- | --- |
| Endpoints | `GET /sse` + `POST /messages?sessionId=…` | un seul : `/mcp` |
| Réponses | toutes sur le flux ouvert au départ | dans la réponse au POST (JSON ou petit flux SSE) |
| Connexion | ouverte en permanence | aucune obligatoire (`GET /mcp` facultatif) |

- Avec l'ancien transport, la question partait par un canal et la réponse
  revenait par l'autre. Cela supposait une connexion longue par client, et
  passait mal derrière un répartiteur de charge ou une plateforme serverless.
- Avec le nouveau, chaque requête porte sa réponse : c'est du HTTP ordinaire.
  Le SDK 1.32.1 marque `SSEServerTransport` et `SSEClientTransport`
  `@deprecated`.
- Observé : la réponse à `initialize` arrive en `content-type: text/event-stream`.
  Le SDK répond par défaut en petit flux SSE, ce qui lui permettrait
  d'envoyer des notifications de progression avant le résultat.

> **À retenir**
> Streamable HTTP, c'est une requête, une réponse, sur un seul endpoint. SSE
> devient une façon de répondre, plus un canal permanent.

---

## Leçon 3 : la session MCP

- **Qui la crée ?** Le serveur, pendant l'`initialize` :
  `sessionIdGenerator: () => randomUUID()`. Il renvoie l'identifiant dans
  l'en-tête de réponse `Mcp-Session-Id`.
- **Comment circule-t-elle ?** Le client renvoie `Mcp-Session-Id` (et
  `Mcp-Protocol-Version`) à **chaque** requête suivante. Un identifiant
  inconnu reçoit un **404**, et le client doit refaire un `initialize`.
  `DELETE /mcp` ferme la session.
- **Une session = un `McpServer`**, construit avec l'utilisateur du jeton.
  La base et la recherche restent partagées par toutes les sessions.
- Une session sans requête depuis 30 min est fermée. Observé :
  l'Inspector en ligne de commande part **sans** `DELETE`.

> **À retenir**
> L'identifiant de session est une étiquette de routage, pas une preuve
> d'identité : il circule en clair, comme un numéro de ticket.

**Question**
1. Pourquoi lire soi-même le corps d'une requête sans session, au lieu de la confier au transport ?

---

## Leçon 4 : l'identité, à chaque requête

```ts
const identity = auth.authenticate(req.headers.authorization);
if (!identity) {
  res.setHeader("WWW-Authenticate", 'Bearer realm="chatbot-rag"');
  return sendJson(res, 401, { error: "Authentification requise." });
}
// …
if (!sameToken(identity, session.identity)) {
  return sendRpcError(res, 403, "Cette session appartient à un autre jeton.");
}
```

- **En stdio, le canal identifie.** Seul le parent peut écrire dans le stdin
  du serveur, et il a choisi l'utilisateur au lancement. Il n'existe pas
  d'« autre client ».
- **En HTTP, le canal n'identifie rien.** Tout processus de la machine peut
  appeler le port, un processus sert plusieurs utilisateurs, et deux requêtes
  d'une même session peuvent arriver sur des connexions différentes. Chaque
  requête doit donc **prouver** qui elle est.
- Le jeton est vérifié **avant tout traitement MCP** : un inconnu ne fait
  lire ni le corps, ni la session. Absent, mal formé ou inconnu : même
  réponse 401.
- La session garde l'empreinte du jeton qui l'a ouverte. Observé : la session
  de chloe avec le jeton de bruno reçoit un **403**, en POST comme en DELETE.
- `MCP_USER_ID` n'est plus lu en HTTP. Observé : avec `MCP_USER_ID=alice`
  dans `.env`, les sessions sont bien celles de chloe et de bruno.

> **À retenir**
> Quand plusieurs clients partagent un serveur, l'identité appartient à la
> requête, pas au processus.

**Question**
1. Que permettrait un serveur qui accepterait n'importe quel jeton valide sur n'importe quelle session ?

---

## Leçon 5 : un jeton vérifié en temps constant

```ts
const digest = sha256(token);
let match: (typeof entries)[number] | null = null;
for (const entry of entries) {
  if (timingSafeEqual(digest, entry.digest)) match = entry;
}
```

- Une comparaison ordinaire (`===`, `map.get`) s'arrête au premier caractère
  différent. En mesurant les temps de réponse, on peut deviner un jeton
  caractère par caractère.
- Trois précautions :
  - comparer des **empreintes SHA-256**, de 32 octets quelle que soit la
    longueur reçue ;
  - utiliser **`timingSafeEqual`**, qui compare tous les octets ;
  - parcourir **tous** les jetons sans sortir de la boucle.
- Le fichier est validé au démarrage : 32 caractères au moins, un jeton par
  utilisateur, utilisateurs connus. Les messages d'erreur ne citent jamais un
  jeton. L'exemple versionné contient des valeurs **invalides**, qu'on ne
  peut pas utiliser par mégarde.
- Logs : `requête refusée (401) : jeton absent`, `session be3c2402 : jeton
  différent…`. Jamais le jeton (0 occurrence dans les logs, vérifié).

> **À retenir**
> Un secret se compare en temps constant, et ne s'écrit nulle part ailleurs
> que là où il est rangé.

---

## Leçon 6 : ce que prévoit la spécification (non implémenté)

Pour les transports HTTP, la spécification MCP s'appuie sur **OAuth 2.1** :

1. Le serveur MCP est un **resource server** : il vérifie des jetons, un
   **serveur d'autorisation** séparé les délivre.
2. Sur un 401, il indique ses métadonnées (`/.well-known/oauth-protected-resource`,
   RFC 9728), qui désignent le serveur d'autorisation.
3. Le client s'enregistre, puis suit le flux *authorization code* avec
   **PKCE** : l'utilisateur se connecte et consent dans son navigateur. Le
   jeton est demandé **pour cette ressource** (`resource`, RFC 8707).
4. Le serveur vérifie à chaque requête la signature, l'expiration,
   l'audience et les scopes. Il ne relaie jamais ce jeton vers une autre API,
   et HTTPS est obligatoire.

Observé : sans jeton, l'Inspector a lu notre `WWW-Authenticate: Bearer` et
**a tenté la découverte OAuth**.

| Notre jeton statique | En production |
| --- | --- |
| n'expire jamais, ne se révoque pas | courte durée, révocable |
| tout ou rien | des scopes |
| stocké en clair, et détenu aussi par l'API | jamais stocké côté serveur : une signature se vérifie |
| en clair sur le loopback | TLS partout |
| pas de consentement, pas d'audience | l'utilisateur autorise, le jeton vise ce serveur |

> **À retenir**
> Notre jeton prouve « je connais un secret du fichier ». OAuth prouve
> « cet utilisateur a autorisé ce client à appeler ce serveur, pour un temps
> et des droits limités ».

---

## Leçon 7 : le client suit

```ts
return new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
```

- `MCP_TRANSPORT=stdio|http` (stdio par défaut), `MCP_HTTP_URL`. En HTTP :
  une **session par utilisateur**, avec son jeton lu dans `mcp-tokens.json`.
- Le cache, la fermeture après 5 min d'inactivité, le disjoncteur et
  l'arrêt propre restent les mêmes. `/chat`, `ToolRegistry`, les événements
  SSE et l'évaluation n'ont pas bougé.
- Ce qui change :
  - fermer = `DELETE` de la session, puis `close()` ;
  - une panne HTTP ne déclenche pas `onclose`, c'est l'appel suivant qui échoue :
    - `ECONNREFUSED` : la connexion est retirée et le disjoncteur armé ;
    - **404** (serveur redémarré) : une nouvelle session est ouverte aussitôt et l'appel recommencé.
- Deux bugs trouvés en testant :
  - la seconde chance reprenait l'ancienne connexion, encore en cache ;
  - le SDK coupe toute requête à **60 s**, même quand notre délai en prévoit
    120 (ce bug datait du cours précédent).

> **À retenir**
> Cacher le transport derrière une interface (`McpPool`) dès le début, c'est
> ce qui permet d'en changer sans toucher au reste de l'application.

---

## Leçon 8 : stdio contre HTTP, mêmes résultats ?

Deux runs `npm run eval -- --user chloe --mode hybrid --rag-mode tool`,
l'un en stdio, l'autre en HTTP :

| | stdio | http |
| --- | --- | --- |
| recherche · citation · abstention · exactitude | 16/16 · 16/16 · 16/20 · 16/16 | 14/16 · 15/16 · 14/20 · 14/16 |
| erreurs | 0 | 2 (q07, q08 : recherches au-delà de 120 s) |

- **Le test du transport** : 14 questions sur 20 ont reçu exactement la même
  question de recherche dans les deux runs. Dans les 14 cas, les passages
  sont **identiques à l'octet près** (fichiers, pages, rangs, scores).
- **Les seules notes différentes** sont celles des deux questions en erreur.
  Le serveur montre trois recherches bloquées 132 à 540 s, puis libérées
  ensemble, pendant une rafale de « 429 » de Voyage (quota de 3 requêtes par
  minute, partagé avec le chat). Le blocage est dans `retrieve`, pas dans le
  transport. Sa cause exacte reste à établir.
- **Aucune réponse n'est identique au caractère près**, même entre deux runs
  stdio. Le modèle n'est pas déterministe : il reformule parfois sa
  recherche (« durée hebdomadaire **du** travail » contre « **de** travail »).
- Pour un run HTTP comparable, il faut lancer le serveur avec le même
  `RAG_SEARCH_MODE` que `--mode`. L'évaluation le rappelle, puisqu'elle ne
  peut pas le vérifier.

> **À retenir**
> Pour tester une couche, compare ce qu'elle produit à entrée égale (mêmes
> recherches → mêmes passages), pas un score qui dépend aussi d'un modèle.

**Question**
1. Pourquoi « scores identiques » est-il un critère trop fort pour comparer deux transports, et lequel est le bon ?

---

## Leçon 9 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| `/mcp` sans jeton, jeton inconnu, schéma `Basic` | 401 + `WWW-Authenticate: Bearer`, rien n'est lu |
| `Host` ou `Origin` étranger (DNS rebinding) | 403, avant tout le reste |
| session d'un autre jeton | 403 « Cette session appartient à un autre jeton. » |
| session inconnue ou fermée | 404, le client rouvre une session |
| requête sans session qui n'est pas un `initialize` | 400 « Aucune session : commence par initialize. » |
| `mcp-tokens.json` absent | refus de démarrer : « Copie … mcp-tokens.example.json et remplace les jetons. » |
| exemple copié tel quel, jeton trop court, utilisateur inconnu, deux jetons pour un utilisateur | refus de démarrer, sans citer de jeton |
| utilisateur sans jeton (côté API) | « aucun jeton MCP pour cet utilisateur », outils maison seuls |
| serveur HTTP arrêté | `ECONNREFUSED`, `error` dans le chat, disjoncteur 30 s |
| serveur HTTP redémarré | 404, nouvelle session, appel réussi |
| recherche de plus de 60 s | réussit désormais (avant : coupée par le SDK) |
| `--transport websocket` | « --transport doit valoir stdio ou http », code 1 |

---

## Leçon 10 : synthèse

### Les idées à emporter

1. Le protocole MCP ne dépend pas du transport : les outils sont restés
   intacts.
2. Streamable HTTP : un endpoint, une réponse par requête, une session
   portée par un en-tête créé par le serveur.
3. En HTTP, l'identité vient de chaque requête ; la session est liée au jeton
   qui l'a ouverte.
4. Un secret se compare en temps constant et ne s'écrit dans aucun log.
5. Le jeton statique est un exercice ; la production, c'est OAuth 2.1, TLS
   et des jetons courts.

### Vérifications manuelles

Lance d'abord le serveur dans un terminal :
`npm run --silent mcp -- --transport http`. Puis, dans un autre terminal à
la racine de `chatbot/` :

```bash
tok() { node -e 'const t=require("./apps/api/data/mcp-tokens.json");console.log(Object.keys(t).find(k=>t[k]===process.argv[1]))' "$1"; }
CH=$(tok chloe); BR=$(tok bruno); U=http://127.0.0.1:3100/mcp
A=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

1. **`/mcp` sans jeton répond 401** (et `/health` répond sans jeton) :
   ```bash
   curl -i -X POST $U "${A[@]}" -d "$INIT"        # 401, WWW-Authenticate: Bearer realm="chatbot-rag"
   curl -i http://127.0.0.1:3100/health            # 200 {"status":"ok"}
   ```
2. **Avec un jeton valide, l'initialisation réussit et les deux outils sont listés** :
   ```bash
   curl -si -X POST $U "${A[@]}" -H "Authorization: Bearer $CH" -d "$INIT" | grep -i -E '^HTTP|mcp-session-id'
   SID=<l'identifiant reçu>
   H=("${A[@]}" -H "Mcp-Session-Id: $SID" -H 'Mcp-Protocol-Version: 2025-06-18')
   curl -s -X POST $U "${H[@]}" -H "Authorization: Bearer $CH" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
   curl -s -X POST $U "${H[@]}" -H "Authorization: Bearer $CH" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   # data: {"result":{"tools":[{"name":"search_documents",…},{"name":"list_documents",…}]}…}
   ```
3. **L'Inspector se connecte en HTTP avec le jeton** :
   ```bash
   npx @modelcontextprotocol/inspector --cli $U --transport http --header "Authorization: Bearer $CH" --method tools/list
   npx @modelcontextprotocol/inspector --transport http --server-url $U --header "Authorization: Bearer $CH"   # web : Connect, Tools
   ```
   Sans `--header`, l'Inspector tente OAuth et échoue : c'est attendu.
4. **Un utilisateur sans droits sur un PDF n'en voit rien** :
   ```bash
   npx @modelcontextprotocol/inspector --cli $U --transport http --header "Authorization: Bearer $BR" \
     --method tools/call --tool-name list_documents                   # discordinvites.pdf seulement
   npx @modelcontextprotocol/inspector --cli $U --transport http --header "Authorization: Bearer $BR" \
     --method tools/call --tool-name search_documents --tool-arg "question=Quelles sont les règles du télétravail ?" --tool-arg k=10
   # aucun passage de reglement-interieur.pdf (appel à Voyage)
   ```
5. **Un autre jeton sur une session existante est refusé** :
   ```bash
   curl -i -X POST $U "${H[@]}" -H "Authorization: Bearer $BR" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
   # 403 « Cette session appartient à un autre jeton. »
   ```
   Dans le terminal du serveur : `jeton différent de celui qui l'a ouverte (utilisateur bruno), refusé`.
6. **Le chat fonctionne en `MCP_TRANSPORT=http`, sources affichées** :
   ajoute `MCP_TRANSPORT=http` dans `apps/api/.env`, puis relance `npm run dev`
   (`tsx watch` ne surveille pas `.env`). Au démarrage, le log de l'API indique
   `mcpTransport: "http"`. Dans l'interface,
   chloe demande « Qui est la référente télétravail ? » : les sources de
   `reglement-interieur.pdf` s'affichent. Le terminal du serveur affiche
   `outil search_documents : ok en … ms (utilisateur chloe, session xxxxxxxx)`.
   Retire la ligne pour revenir au stdio.

### Pour aller plus loin (non fait, volontairement)

OAuth 2.1 (métadonnées RFC 9728, PKCE, audience), TLS et exposition hors de
localhost, création et révocation des jetons, empreintes au lieu des jetons
dans le fichier côté serveur, mode sans session, tests automatisés, et la
cause exacte des recherches bloquées sous quota Voyage.

---

## Corrigé des questions

**L3.1** Pour savoir **avant** de créer une session que la requête est bien
un `initialize`. Sinon, n'importe quel POST ouvrirait une session et un
`McpServer` en mémoire.

**L4.1** bruno, qui a un jeton valide, pourrait reprendre une session de
chloe dont il aurait vu l'identifiant (un log, un proxy) et lire ses
documents. L'identifiant de session deviendrait un mot de passe.

**L8.1** Les scores dépendent aussi du modèle, qui n'est pas déterministe :
deux runs dans le même transport diffèrent déjà. Le bon critère compare la
couche testée à entrée égale : mêmes questions de recherche, mêmes passages.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-4-serveur-distant.md).
