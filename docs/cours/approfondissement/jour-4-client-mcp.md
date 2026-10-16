# Jour 4 · Cours 3 — L'API, client MCP : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-4-client-mcp.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Trois chantiers dans ce cours :
- un **client MCP** dans l'API (`apps/api/src/mcp/`), qui lance un serveur par utilisateur et
  transforme ses outils en outils du registre ;
- la route `/chat` en mode **`tool`**, où le modèle décide de chercher ;
- l'**évaluation** dans les deux modes, avec la robustesse et l'arrêt propre.

Le serveur MCP (`apps/mcp-server`) n'a pas changé d'une ligne.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/package.json` | dépendance `@modelcontextprotocol/sdk`, script `mcp:probe` | 1 |
| `apps/api/src/mcp/pool.ts` | `createMcpPool` : un sous-processus par utilisateur, cache, inactivité, disjoncteur, `close` | 1, 2, 7, 8 |
| `apps/api/src/mcp/tools.ts` | `loadMcpTools`, `loadMcpToolsOrFallback`, `toExternalTool`, préfixe, `UNAVAILABLE_MESSAGE` | 3, 7 |
| `apps/api/src/mcp/probe.ts` | `npm run mcp:probe` : le client sans le modèle | 1, 2 |
| `apps/api/src/tools/types.ts`, `registry.ts` | `ExternalTool`, `AnyTool`, délai par outil | 3 |
| `apps/api/src/rag/prompt.ts` | règles partagées, `RAG_SYSTEM_PROMPT` inchangé, `buildToolSystemPrompt`, `formatDocuments` | 4, 5 |
| `apps/api/src/chat/search-results.ts` | `createSearchResults` : numérotation globale, bloc `<documents>`, sources | 5 |
| `apps/api/src/chat/conversation.ts` | `runConversation` : la boucle sortie de la route, `onToolResult` | 4, 8 |
| `apps/api/src/routes/chat.ts` | les deux modes, `sources`, `error` final si la recherche a échoué | 4, 5, 7 |
| `apps/api/src/config.ts` | `RAG_MODES`, `loadRagMode` | 4 |
| `apps/api/src/server.ts` | `localTools`, `createMcpPool`, `onClose`, SIGINT/SIGTERM | 8 |
| `apps/api/src/evals/run.ts` et voisins | `--rag-mode`, `runToolQuestion`, `recherches`, colonne `rag` | 6 |

## Le parcours dans le code

chloe envoie « Qui est la référente télétravail ? » depuis l'interface, `RAG_MODE` absent.

1. **`server.ts`** au démarrage : `loadRagMode()` vaut `"tool"` ; `createMcpPool({ log: app.log })`
   ne lance rien.
2. **`POST /api/chat`** (`routes/chat.ts`) : `identifyUser` → chloe ; validation du corps ;
   `reply.hijack()` et flux SSE ouvert.
3. Mode `tool` : **`createSearchResults()`**, puis
   **`loadMcpToolsOrFallback(mcp, "chloe", { formatResult: results.format })`**.
4. → **`loadMcpTools`** → **`pool.listTools("chloe")`** → **`use`** → **`getConnection`** : pas de
   connexion en cache, disjoncteur fermé → **`connect`** : `StdioClientTransport` lance
   `node --import tsx --conditions=development …/mcp-server/src/index.ts` avec `MCP_USER_ID=chloe` ;
   `client.connect` fait `initialize`. Log `serveur MCP démarré {mcpUser, mcpPid, durationMs}`.
5. `client.listTools()` → `search_documents`, `list_documents` ; **`toExternalTool`** les
   préfixe : `mcp__rag__search_documents`, `mcp__rag__list_documents`.
6. **`createToolRegistry([...localTools, ...mcpTools.tools])`** : quatre outils.
7. **`runConversation`** (`chat/conversation.ts`), tour 1 : le modèle reçoit `TOOL_SYSTEM_PROMPT`,
   la conversation et les quatre outils ; il demande
   `mcp__rag__search_documents {"question": "Qui est la référente télétravail ?"}`.
8. **`executeToolCall`** : événement `tool_call` → **`registry.execute`** : outil externe, délai 15 s,
   pas de validation locale → **`toExternalTool.execute`** → **`pool.callTool("chloe",
   "search_documents", input, signal)`** → JSON-RPC `tools/call` sur le stdin du serveur.
9. Le serveur cherche (Voyage + SQL filtré par les groupes de chloe), renvoie `content` et
   `structuredContent`. **`results.format`** reconstruit le bloc `<documents>` numéroté [1]…[5].
10. Log `outil exécuté {tool, userId, durationMs, ok}`, événement `tool_result`, puis
    **`onToolResult`** dans la route : succès → événement `sources`.
11. Tour 2 : le modèle lit le résultat et répond en citant [1] ; les `delta` partent au navigateur.
    Pas d'appel d'outil → `completed: true` → `done`.
12. Cinq minutes sans message de chloe : le minuteur ferme son serveur (`serveur MCP inactif,
    fermeture`, puis `serveur MCP fermé`).

## `apps/api/src/mcp/pool.ts`

> Depuis le [cours 4](jour-4-serveur-distant.md), `pool.ts` sait aussi se connecter en HTTP.
> Les extraits ci-dessous montrent l'état du code à la fin du cours 3 (stdio). Les noms ont
> un peu bougé depuis : `connection.pid` est devenu `connection.tag` (`{ mcpPid }`), et les
> messages de log sont rangés dans `MESSAGES.stdio`. La logique décrite ici n'a pas changé.

### L'interface `McpPool`

```ts
export interface McpPool {
  /** Les outils du serveur, tels qu'il les déclare (noms non préfixés). */
  listTools(userId: string): Promise<McpTool[]>;
  callTool(userId: string, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
  /** Ferme tous les sous-processus et renvoie leur nombre. Un appel suivant en relance un. */
  close(): Promise<number>;
}
```

**Ce que fait le code** : trois méthodes, toutes indexées par `userId`. Aucune ne renvoie de
processus ni de client MCP.

**Pourquoi** : l'appelant pense « les outils de bruno », pas « le processus 12345 ». Démarrer,
réutiliser, relancer : tout reste caché ici. Le pool ne vérifie pas l'identifiant ; c'est la route
qui l'a déjà résolu dans `users.json` (et le serveur refuserait de démarrer pour un inconnu).

### Les constantes de lancement

```ts
const SERVER_ENTRY = fileURLToPath(new URL("../../../mcp-server/src/index.ts", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../../../mcp-server/", import.meta.url));
/** Le chargeur de tsx, résolu depuis apps/api (où tsx est installé). */
const TSX_LOADER = import.meta.resolve("tsx");
```

**Ce que fait le code** : chemins calculés depuis le fichier lui-même (`import.meta.url`), donc
indépendants du dossier d'où l'API est lancée. `import.meta.resolve("tsx")` donne l'URL du
chargeur `…/node_modules/tsx/dist/loader.mjs`.

**Pourquoi** :
- **Pas `npm run mcp`** : il compilerait (`tsc -b`) à chaque démarrage, et le pid serait celui de
  `npm`, pas du serveur. Tuer « le serveur » tuerait alors `npm`, et son enfant pourrait survivre.
- **`process.execPath`** : le même Node que l'API, quelle que soit la configuration de `PATH`.
- **`--conditions=development`** : `@chatbot/rag` se résout vers ses sources, comme pour l'API. Une
  modification du package vaut pour les deux sans build.

### `connect` : le lancement

```ts
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", TSX_LOADER, "--conditions=development", SERVER_ENTRY],
  cwd: SERVER_DIR,
  env: { ...getDefaultEnvironment(), ...env, MCP_USER_ID: userId },
  stderr: "pipe",
});
if (transport.stderr) {
  createInterface({ input: transport.stderr as Readable }).on("line", (line) =>
    log.info({ mcpUser: userId }, line.replace(/^\[mcp\] /, "serveur MCP : ")),
  );
}
```

**Ce que fait le code** :
1. Décrit le sous-processus. Rien n'est lancé tant que `client.connect(transport)` n'est pas appelé.
2. `env` : `getDefaultEnvironment()` (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), puis les
   variables passées au pool (l'évaluation y met `RAG_SEARCH_MODE`), puis l'identité, **en
   dernier** : rien ne peut l'écraser.
3. `stderr: "pipe"` : le stderr du serveur devient un flux lisible côté API. `readline` le découpe
   en lignes, chacune devient un log `info` avec `mcpUser`.

**Pourquoi** :
- **Pas `...process.env`** : l'environnement de l'API contient `LLM_API_KEY`. Le serveur n'en a pas
  besoin ; moins il reçoit de secrets, moins il peut en fuir. Il lit lui-même `apps/api/.env`.
- **`MCP_USER_ID` en dernier** : un `env` mal construit (`{ MCP_USER_ID: "chloe" }` passé par
  erreur au pool) ne peut pas changer l'identité d'un serveur.
- **`as Readable`** : le SDK type `transport.stderr` en `Stream`, mais c'est un `PassThrough`.
  `readline` exige un flux lisible : le cast dit ce que le type ne dit pas.

### `connect` : fermeture, plantage, démarrage raté

```ts
client.onclose = () => {
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  onClosed();
  if (connection.closing) {
    log.info({ mcpUser: userId, mcpPid: connection.pid }, "serveur MCP fermé");
  } else if (connection.pid !== null) {
    failedAt.set(userId, Date.now());
    log.warn({ mcpUser: userId, mcpPid: connection.pid, retryInMs: retryDelayMs }, "serveur MCP arrêté de façon inattendue");
  }
};

try {
  await client.connect(transport);
} catch (error) {
  failedAt.set(userId, Date.now());
  log.warn({ mcpUser: userId, retryInMs: retryDelayMs }, "le serveur MCP n'a pas pu démarrer");
  throw new McpUnavailableError("Le serveur MCP n'a pas pu démarrer.", { cause: error });
}
connection.pid = transport.pid;
```

**Ce que fait le code** :
1. `onclose` est appelé par le SDK quand le stdout du serveur se ferme, **quelle qu'en soit la
   cause**. Dans tous les cas, la connexion sort du cache (`onClosed`).
2. `closing` distingue les deux cas : vrai si c'est nous qui fermons (inactivité, arrêt), faux sinon.
   Un arrêt non voulu arme le **disjoncteur** (`failedAt`).
3. `pid !== null` : un serveur qui meurt pendant `connect` déclenche aussi `onclose`, mais le
   `catch` s'en charge déjà ; on ne compte pas la panne deux fois.
4. Un `connect` qui échoue arme le disjoncteur et lève `McpUnavailableError`.

**Pourquoi** :
- **Un seul point de sortie du cache** : que le serveur meure d'inactivité ou de `kill -9`, la
  prochaine demande en lance un neuf (ou attend le disjoncteur). Pas de connexion morte servie.
- **Pas la raison exacte dans le warn** : le serveur l'a déjà écrite sur son stderr, donc dans nos
  logs (`serveur MCP : démarrage impossible : connect ECONNREFUSED …`).
- **`mcpPid`, pas `pid`** : pino écrit déjà `pid` (celui de l'API) dans chaque ligne ; un champ
  `pid` l'écrasait, et on croyait lire le pid de l'API.

### `getConnection` : cache et disjoncteur

```ts
const lastFailure = failedAt.get(userId);
if (lastFailure !== undefined && Date.now() - lastFailure < retryDelayMs) {
  const seconds = Math.ceil((retryDelayMs - (Date.now() - lastFailure)) / 1000);
  return Promise.reject(new McpUnavailableError(`Serveur MCP indisponible, nouvel essai dans ${seconds} s.`));
}
failedAt.delete(userId);

const forget = () => {
  if (connections.get(userId) === pending) connections.delete(userId);
};
const pending = connect(userId, forget);
connections.set(userId, pending);
pending.catch(forget);
return pending;
```

**Ce que fait le code** :
1. Une connexion en cache (même en cours de démarrage) est renvoyée telle quelle (plus haut dans
   la fonction).
2. Sinon, si la dernière panne de cet utilisateur date de moins de 30 s : refus immédiat.
3. Sinon : on lance, et on met **la promesse** en cache avant même qu'elle soit résolue.
4. `forget` retire l'entrée seulement si c'est **toujours celle-ci**.

**Pourquoi** :
- **La promesse en cache** : trois appels simultanés de bruno pendant le démarrage attendent tous
  la même promesse. Un seul processus (observé : 3 appels, 1 démarrage).
- **`connections.get(userId) === pending`** : un vieux serveur qui se ferme en retard ne doit pas
  effacer son successeur. Une première version utilisait une variable partagée, juste pour un seul
  utilisateur, fausse dès qu'il y en a deux.
- **`pending.catch(forget)`** : un démarrage raté gardé en cache renverrait la même erreur à
  chaque message, pour toujours.
- **Le disjoncteur** : une base arrêtée fait échouer chaque démarrage après ~1 s. Sans lui, chaque
  message paierait cette seconde et un processus de plus. 30 s : assez pour souffler, assez court
  pour qu'une panne passagère se répare seule.

### `armIdleTimer` et `use`

```ts
connection.idleTimer = setTimeout(() => {
  if (connection.active > 0) return;
  log.info({ mcpUser: userId, mcpPid: connection.pid }, "serveur MCP inactif, fermeture");
  connection.closing = true;
  void connection.client.close();
}, idleMs);
connection.idleTimer.unref();
```

```ts
async function use<T>(userId: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = await getConnection(userId);
  connection.active += 1;
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  try {
    return await fn(connection);
  } finally {
    connection.active -= 1;
    if (connection.active === 0) armIdleTimer(userId, connection);
  }
}
```

**Ce que fait le code** : chaque appel incrémente `active` et suspend le minuteur ; le dernier
appel terminé le réarme. Au bout de 5 min sans appel, `closing = true` puis `client.close()`.

**Pourquoi** :
- **Jamais pendant un appel** : une recherche qui attend Voyage (quota) peut durer plus longtemps
  que prévu ; la couper ferait échouer une réponse en cours.
- **`closing` avant `close()`** : sinon `onclose` y verrait un plantage et armerait le disjoncteur.
- **`unref()`** : un script (`mcp:probe`, `eval`) peut se terminer sans attendre 5 min un minuteur.

### `listTools`, `callTool`, `close`

```ts
listTools(userId) {
  return use(userId, (connection) => {
    connection.tools ??= connection.client.listTools().then((result) => result.tools);
    return connection.tools;
  });
},
```

**Ce que fait le code** : la liste des outils est demandée une fois par serveur, puis réutilisée
(elle vit dans la connexion, donc meurt avec elle). `callTool` passe `signal` au SDK.
`close()` vide le cache, attend les démarrages en cours, puis ferme tous les clients avec
`closing = true`, et renvoie leur nombre.

**Pourquoi** :
- **La liste en cache** : `/chat` la demande à chaque message ; elle ne change pas pendant la vie
  du serveur.
- **`signal`** : si l'utilisateur ferme l'onglet, le SDK envoie `notifications/cancelled` au
  serveur au lieu d'attendre une réponse que personne ne lira.
- **`client.close()`** : le transport ferme le stdin du serveur (qui s'arrête de lui-même), puis
  envoie SIGTERM après 2 s, SIGKILL après 2 s encore.

## `apps/api/src/mcp/tools.ts`

### `toExternalTool`

```ts
async execute(input, { signal }) {
  let result: CallToolResult;
  try {
    result = await pool.callTool(userId, tool.name, input, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, content: UNAVAILABLE_MESSAGE };
  }
  if (result.isError) return { ok: false, content: textOf(result) };
  return { ok: true, content: options.formatResult?.(tool.name, result) ?? textOf(result) };
},
```

**Ce que fait le code** : trois issues.
1. **Exception** : délai dépassé ou client parti (`signal.aborted`) → on relance, le registre sait
   en faire un message (« a dépassé le délai de 15000 ms ») ; sinon serveur tombé ou disjoncteur →
   `UNAVAILABLE_MESSAGE`.
2. **`isError`** : le serveur a répondu « échec » (validation -32602, Voyage en panne) → son texte,
   tel quel.
3. **Succès** : `formatResult` peut réécrire le résultat (la route s'en sert pour
   `search_documents`) ; sinon les blocs texte mis bout à bout.

**Pourquoi** :
- **Le serveur reçoit `tool.name`**, son nom à lui. Le préfixe n'existe que côté modèle.
- **Un message choisi en cas de panne** : pas de « Connection closed » ni de pid. Le modèle reçoit
  une consigne : dis-le, propose de réessayer, ne réponds pas de mémoire.
- **`formatResult` en option** : `tools.ts` ne sait rien des sources ni de la numérotation. Le
  pool et les outils resteraient valables pour un autre serveur MCP.

### `describe`

```ts
return {
  name: `${MCP_TOOL_PREFIX}${tool.name}`,
  description: tool.description ?? tool.title ?? tool.name,
  inputSchema: withoutMetaSchema(tool.inputSchema),
};
```

**Ce que fait le code** : nom préfixé `mcp__rag__`, description du serveur, schéma JSON sans
`$schema`.

**Pourquoi** :
- **Le préfixe** : la convention de Claude Code (`mcp__<serveur>__<outil>`). Un outil maison
  nommé `search_documents` ne peut pas entrer en collision, et le registre lèverait de toute façon
  « Outil déclaré deux fois ».
- **Pas de conversion en Zod** : `z.fromJSONSchema` existe (Zod 4.6), mais convertir pour valider
  ici dupliquerait la validation du serveur, avec des écarts possibles (`default`, formats). Le
  schéma part au modèle tel que le serveur l'a écrit ; le serveur valide.

### `loadMcpToolsOrFallback`

```ts
try {
  return { tools: await loadMcpTools(pool, userId, options), available: true };
} catch {
  const tools = (lastKnownTools ?? FALLBACK_TOOLS).map((tool) => ({
    ...describe(tool),
    execute: async () => ({ ok: false, content: UNAVAILABLE_MESSAGE }),
  }));
  return { tools, available: false };
}
```

**Ce que fait le code** : si le serveur ne démarre pas (ou si le disjoncteur est ouvert), on
déclare quand même les outils : les derniers connus (`lastKnownTools`, mis à jour par chaque
`loadMcpTools` réussi), ou à défaut un `search_documents` minimal écrit en dur. Tous répondent
« indisponible ».

**Pourquoi** :
- **Garder l'outil dans la liste** : sans lui, le modèle ne saurait pas que des documents existent,
  et répondrait de mémoire à « Qui est la référente télétravail ? ». Avec lui, il l'appelle, lit
  « indisponible », et le dit.
- **`lastKnownTools` partagé entre utilisateurs** : les descriptions ne citent aucun document, elles
  sont les mêmes pour tous. Aucune fuite.
- **Rien dans le prompt système** : un « la recherche est indisponible » dans le prompt pousserait
  le modèle à l'annoncer même pour « Bonjour ». L'appel d'outil, lui, n'a lieu que pour une
  question documentaire.

## `apps/api/src/tools/types.ts` et `registry.ts`

```ts
export interface ExternalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult>;
  timeoutMs?: number;
}

export type AnyTool = Tool | ExternalTool;
```

```ts
const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
// …
if (isExternal(tool)) {
  return await Promise.race([tool.execute(input, { signal: combined }), rejectOnAbort(combined)]);
}
```

**Ce que fait le code** :
1. Un `ExternalTool` porte un JSON Schema au lieu d'un schéma Zod, reçoit `input: unknown`, et
   renvoie directement un `ToolExecutionResult` (`{ ok, content }`).
2. `isExternal` les distingue par la présence de `inputSchema`.
3. Le délai d'un outil prime sur celui de l'appelant (15 s pour MCP, 5 s par défaut).
4. Le même `Promise.race` qu'un outil maison : un outil qui ignore son signal est quand même borné.

**Pourquoi** :
- **`execute` renvoie le résultat final** : un outil maison renvoie un objet que le registre
  sérialise en JSON ; un outil MCP renvoie déjà du texte destiné au modèle. Le sérialiser une
  seconde fois donnerait `"\"La recherche a trouvé…\""`.
- **Un délai par outil** : la première recherche d'un utilisateur paie le démarrage du serveur
  (~0,5 s) plus Voyage ; 5 s ne suffisent pas toujours. Les outils maison gardent 5 s.

## `apps/api/src/rag/prompt.ts`

### Les règles partagées

```ts
const ONLY_FROM_EXCERPTS = [
  "Réponds uniquement à partir de ces extraits. N'utilise jamais tes connaissances générales pour compléter,",
  "   même partiellement, même si tu crois connaître la réponse.",
].join("\n");
```

**Ce que fait le code** : `INTRO`, `ONLY_FROM_EXCERPTS`, `CITE_EXCERPTS`, `SAY_I_DONT_KNOW`,
`DATA_NOT_INSTRUCTIONS` sont des constantes ; `numbered()` les numérote. `RAG_SYSTEM_PROMPT` et
`buildToolSystemPrompt` les assemblent.

**Pourquoi** : les règles de réponse sont les mêmes dans les deux modes. Les écrire une fois évite
qu'un mode dérive. `RAG_SYSTEM_PROMPT` est resté **identique à l'octet près** (vérifié) : le run
`always` reproduit exactement l'historique précédent, la comparaison est honnête.

### `buildToolSystemPrompt`

**Ce que fait le code** : huit règles. Les deux premières sont nouvelles (quand chercher, comment
formuler), puis les quatre règles partagées, puis la règle des numéros et celle des outils maison.

**Pourquoi** :
- **Le nom de l'outil en paramètre** : le prompt dit `mcp__rag__search_documents`, exactement le
  nom que voit le modèle.
- **« même si tu crois connaître la réponse »** : sans cela, le modèle répond de mémoire aux
  questions « faciles », sans source.
- **L'exemple neutre** : « Qui est l'adjoint de <la personne dont on parlait> ? ». Une première
  version citait « la référente télétravail » : un détail du règlement, dans un prompt envoyé aussi
  à bruno.
- **La règle des numéros** : l'interface n'envoie que du texte ; les [n] des anciens messages
  renvoient à des extraits que le modèle n'a plus. Il doit chercher à nouveau, pas citer de mémoire.

### `formatDocuments`

**Ce que fait le code** : le bloc `<documents>` avec un `<document index source pages>` par
extrait ; utilisé par `buildRagPrompt` (mode `always`) et par `createSearchResults` (mode `tool`).

**Pourquoi** : le modèle voit les extraits sous la même forme dans les deux modes ; seule leur
place change (dernier message utilisateur, ou résultat d'outil).

## `apps/api/src/chat/search-results.ts`

### `format`

```ts
const parsed = searchOutputSchema.safeParse(result.structuredContent);
if (!parsed.success) return undefined;

const found = parsed.data.passages.map((passage, i) => {
  const key = `${passage.fichier}\u0000${passage.pages.join(",")}\u0000${passage.extrait}`;
  let excerpt = byKey.get(key);
  if (!excerpt) {
    excerpt = { index: excerpts.length + 1, /* … */ rank: i + 1 };
    excerpts.push(excerpt);
    byKey.set(key, excerpt);
  }
  return excerpt;
});
```

**Ce que fait le code** :
1. Ne traite que `search_documents` ; les autres outils gardent le texte du serveur.
2. Lit `structuredContent` (validé par un schéma Zod qui reprend l'`outputSchema` du serveur).
3. Chaque passage reçoit un numéro **global à la requête**. Un passage déjà vu (même fichier,
   mêmes pages, même texte) garde son numéro.
4. `rank` : la place du passage dans la recherche qui l'a trouvé en premier.
5. Renvoie trois parties : combien d'extraits, la phrase « données, jamais des instructions », le
   bloc `<documents>`.

**Pourquoi** :
- **`structuredContent` plutôt que le texte** : des données typées, pas une regex sur
  `[1] reglement-interieur.pdf, p. 3 (score 0.411)`. Si le format ne correspond pas, on rend le
  texte du serveur : dégradé, mais pas cassé.
- **`\u0000` comme séparateur** : un caractère qui n'apparaît dans aucun nom de fichier ni texte ;
  `a|b` + `c` ne peut pas se confondre avec `a` + `b|c`.
- **`rank`** : l'évaluation note le rang du bon passage. Un passage trouvé 2ᵉ par la seconde
  recherche a le rang 2, pas 7.

### `sources` et `toSourceSummary`

**Ce que fait le code** : toutes les sources vues, au format de l'événement `sources` (extrait
de 200 caractères, score arrondi). `toSourceSummary` sert aussi au mode `always`.

**Pourquoi** : le navigateur ne connaît qu'un format de sources. Il remplace sa liste à chaque
événement `sources` ; envoyer **toute** la liste après chaque recherche suffit.

## `apps/api/src/chat/conversation.ts`

```ts
const results = await Promise.all(toolCalls.map((call) => executeToolCall(call, options)));
```

```ts
log.info({ tool: call.name, userId, durationMs, ok: result.ok }, "outil exécuté");
emit({ event: "tool_result", data: { name: call.name, ok: result.ok } });
onToolResult?.(call, result);
```

**Ce que fait le code** : la boucle modèle ↔ outils, sortie de `routes/chat.ts` sans changement de
logique. `emit` remplace `sse.send`, `onToolResult` est appelé après chaque outil. Elle renvoie
`completed` et **tout le texte** produit.

**Pourquoi** :
- **Sortie de la route** : l'évaluation doit faire exactement la même conversation que `/chat`.
  Avec `emit: () => undefined`, la même boucle tourne sans navigateur.
- **`onToolResult` plutôt qu'un `if` dans la boucle** : la boucle ignore ce qu'est une recherche.
  La route envoie `sources`, l'évaluation compte les recherches : chacun son rappel.
- **Tout le texte** : le modèle peut écrire « Je cherche… » au tour 1, puis la réponse au tour 2.
  L'évaluation note l'ensemble, comme l'utilisateur le lit.
- **Le log** : outil, utilisateur, durée, succès. Ni `call.input` (la question), ni
  `result.content` (les extraits).

## `apps/api/src/routes/chat.ts`

### Le mode `tool`

```ts
onToolResult: ({ name }, result) => {
  if (name !== SEARCH_TOOL_NAME) return;
  if (result.ok) {
    sse.send({ event: "sources", data: { sources: results.sources() } });
  } else if (!isInvalidArguments(result.content)) {
    searchFailed = true;
  }
},
```

```ts
if (completed && searchFailed) {
  sse.send({ event: "error", data: { message: SEARCH_FAILED_MESSAGE } });
} else if (completed) {
  sse.send({ event: "done", data: {} });
}
```

**Ce que fait le code** :
1. Un `createSearchResults()` **par requête**, passé à `loadMcpToolsOrFallback` comme `formatResult`.
2. Après chaque recherche réussie : `sources`. Après un échec qui n'est pas une erreur de
   validation : drapeau `searchFailed`.
3. En fin de réponse : `error` au lieu de `done` si une recherche a échoué.

**Pourquoi** :
- **L'`error` à la fin** : `useChat` arrête de lire le flux au premier `error`. Envoyé tout de
  suite, il couperait l'explication du modèle (« La recherche est indisponible… »).
- **`isInvalidArguments`** : `k: 20` donne `MCP error -32602…`. C'est le modèle qui s'est trompé ;
  il corrige au tour suivant, la recherche marche. Pas de bandeau d'erreur pour ça.
- **Un registre par requête** : les outils MCP sont liés à l'utilisateur (`userId` capturé dans
  `execute`). Un registre global servirait les outils de chloe à bruno.

### Le mode `always`

**Ce que fait le code** : l'ancien flux, inchangé : `searchDocuments`, `sources`, `buildRagPrompt`,
puis `runConversation` avec les seuls outils maison.

**Pourquoi** : pouvoir revenir en arrière par une variable, et comparer les deux modes dans
l'évaluation sans réécrire l'ancien chemin.

## `apps/api/src/config.ts`

```ts
export const RAG_MODES = ["always", "tool"] as const;

export function loadRagMode(): RagMode {
  loadDotEnv();
  const raw = process.env["RAG_MODE"]?.trim() || "tool";
  if (!(RAG_MODES as readonly string[]).includes(raw)) {
    throw new ConfigError(`RAG_MODE doit valoir ${RAG_MODES.join(", ")} (reçu : "${raw}").`);
  }
  return raw as RagMode;
}
```

**Pourquoi** : une faute de frappe (`RAG_MODE=tools`) ne doit pas retomber silencieusement sur un
mode : l'API refuse de démarrer, avec la liste des valeurs. `RAG_MODES` sert aussi à valider
`--rag-mode` dans l'évaluation.

## `apps/api/src/server.ts`

```ts
const mcp = createMcpPool({ log: app.log });
app.addHook("onClose", async () => {
  const [, closed] = await Promise.all([pool.end(), mcp.close()]);
  app.log.info({ mcpServers: closed }, "serveurs MCP fermés");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "arrêt demandé");
    void app.close().then(() => process.exit(0));
  });
}
```

**Ce que fait le code** : le pool est créé au démarrage, vide. À l'arrêt, `onClose` ferme la base
et les serveurs MCP en parallèle. Ctrl+C et SIGTERM déclenchent `app.close()`.

**Pourquoi** :
- **Rien de lancé au démarrage** : un serveur MCP en panne n'empêche pas l'API de démarrer ; seuls
  les utilisateurs actifs coûtent un processus.
- **Les signaux** : Fastify ne les écoute pas. Sans ces lignes, Ctrl+C tue l'API d'un coup ; les
  serveurs MCP voient leur stdin se fermer et s'arrêtent quand même, mais personne n'attend leur
  fin, et le hook `onClose` ne tourne pas.
- **`process.once`** : un second Ctrl+C reprend le comportement par défaut et tue tout, si
  l'arrêt propre traîne.

## L'évaluation (`apps/api/src/evals/`)

### `run.ts`

```ts
const mcp = ragMode === "tool" ? createMcpPool({ log: mcpLog, env: { RAG_SEARCH_MODE: mode } }) : null;
```

```ts
onToolResult: ({ name, input }, toolResult) => {
  if (name !== SEARCH_TOOL_NAME) return;
  const asked = (input as { question?: unknown } | null)?.question;
  searchQuestions.push(typeof asked === "string" ? asked : "");
  if (!toolResult.ok) failures.push(toolResult.content.slice(0, 200));
},
```

**Ce que fait le code** :
1. `--rag-mode` (sinon `RAG_MODE`) choisit `runQuestion` (ancien chemin) ou `runToolQuestion`.
2. En mode `tool`, le pool passe `RAG_SEARCH_MODE` au serveur : `--mode hybrid` vaut aussi pour la
   recherche faite par le serveur MCP.
3. `runToolQuestion` fait la même conversation que `/chat` (`runConversation`,
   `TOOL_SYSTEM_PROMPT`, outils maison + MCP), compte les recherches et note leurs questions
   (`recherches`, `questions_recherche`).
4. Une recherche en échec devient une `erreur` du résultat : le run est exclu de l'historique.
5. `config.rag` et le sha du prompt **réellement utilisé** sont écrits dans le run.

**Pourquoi** :
- **`EVAL_SEARCH_TIMEOUT_MS = 120_000`** : l'évaluation enchaîne les recherches ; Voyage limite à
  3 requêtes par minute et le client réessaie sur 429. Deux recherches parallèles dépassaient les
  15 s de `/chat`. Ici on préfère attendre que noter un faux échec.
- **Les questions de recherche dans le rapport** : c'est là qu'on voit la reformulation de q06 et
  les deux recherches de q15.
- **`rang = excerpt.rank`** : le grader recherche reste comparable entre les deux modes.

### `report.ts`, `scoring.ts`, `history.ts`, `compare.ts`

**Ce que fait le code** : le mode apparaît dans l'en-tête des rapports (`RAG tool`), dans
`history.jsonl` (`rag`, `"always"` pour les anciennes lignes) et dans une colonne de
`eval:history` ; `eval:compare` montre le mode de chaque run et une ligne « Questions où le
modèle a cherché ».

**Pourquoi** : deux runs dont on ignore le mode ne se comparent pas.

## Pour explorer toi-même

- **Le client sans le modèle** : `npm run mcp:probe -- --user chloe` **(Voyage, 1 requête)**. À voir :
  `serveur MCP démarré {…durationMs}` sur stderr, les quatre outils `[maison]` / `[MCP   ]`, le bloc
  texte de la recherche, `ok true` et sa durée. Puis `--user bruno --k 10` : uniquement
  `discordinvites.pdf`.
- **La validation par le serveur** : `npm run mcp:probe -- --user chloe --k 20` → `ok false`,
  `MCP error -32602: Input validation error…`, sans appel à Voyage.
- **Un seul démarrage pour des appels simultanés** : dans un script `.mts` lancé avec
  `npx tsx --conditions=development`, `Promise.all` de trois `pool.listTools("chloe")` → une seule
  ligne `serveur MCP démarré`.
- **L'inactivité** : `createMcpPool({ log, idleMs: 2000 })`, un appel, puis attendre 3 s :
  `serveur MCP inactif, fermeture` puis `serveur MCP fermé`, et `ps` ne montre plus le processus.
- **Le prompt envoyé** : `debug: true` dans le corps de `/chat` ; l'événement `model_request` du
  tour 1 contient `system` (les huit règles) et les quatre outils avec leurs schémas.
- **Le disjoncteur** : API lancée sur un port libre (`PORT=3002 npm run dev -w apps/api`), un
  message de chloe, `kill <mcpPid>` lu dans le log. Message suivant dans les 30 s : log
  `outils MCP indisponibles pour cette requête`, aucun `serveur MCP démarré`. Après 30 s : un
  nouveau pid.
- **Un serveur qui ne démarre pas** : `createMcpPool({ log, env: { DATABASE_URL:
  "postgres://rag:rag@localhost:5499/rag" } })` dans un script. Le stderr du serveur dit
  `ECONNREFUSED`, puis `le serveur MCP n'a pas pu démarrer`, et `loadMcpToolsOrFallback` renvoie
  `available: false`.
- **L'ancien mode** : `RAG_MODE=always PORT=3002 npm run dev -w apps/api`. « Bonjour » produit un
  événement `sources` : la recherche a eu lieu quand même.
- **L'arrêt propre** : Ctrl+C sur une API qui a servi un message : `arrêt demandé`, `serveur MCP
  fermé`, `serveurs MCP fermés {"mcpServers":1}`, puis `pgrep -f mcp-server/src/index.ts` ne renvoie
  rien.
