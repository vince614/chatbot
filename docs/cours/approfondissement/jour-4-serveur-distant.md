# Jour 4 · Cours 4 — Le serveur MCP distant : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-4-serveur-distant.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Trois chantiers dans ce cours :
- le serveur MCP apprend un second transport, **Streamable HTTP** (`apps/mcp-server/src/transports/`) ;
- ce transport exige un **jeton** par requête (`auth.ts`, `packages/rag/src/mcp-tokens.ts`) ;
- le **client** de l'API (`apps/api/src/mcp/pool.ts`) sait s'y connecter.

Les outils (`apps/mcp-server/src/tools/`) n'ont pas changé.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/mcp-server/src/index.ts` | `--transport`, base et recherche partagées, arrêt | 1 |
| `apps/mcp-server/src/config.ts` | `loadMcpConfig` (commun), `loadStdioUser`, `loadHttpTokens`, `loadHttpPort`, `parseTransport` | 1, 4 |
| `apps/mcp-server/src/server.ts` | `createRagServer(context)` : le serveur et ses deux outils | 1 |
| `apps/mcp-server/src/transports/stdio.ts` | l'ancien mode, déplacé | 1 |
| `apps/mcp-server/src/transports/http.ts` | `startHttp` : Host/Origin, `/health`, jeton, sessions, expiration | 2, 3, 4 |
| `apps/mcp-server/src/transports/tool-log.ts` | `observeToolCalls` : les appels d'outils vus depuis le transport | 7 |
| `apps/mcp-server/src/auth.ts` | `createAuthenticator`, `sameToken` : jetons en temps constant | 5 |
| `packages/rag/src/mcp-tokens.ts` | `loadMcpTokens` : lecture, validation, résolution des utilisateurs | 5 |
| `apps/api/data/mcp-tokens.example.json`, `.gitignore` | le modèle versionné (valeurs invalides), le vrai fichier ignoré | 5 |
| `apps/api/src/config.ts` | `MCP_TOKENS_FILE`, `loadMcpTransport` | 7 |
| `apps/api/src/mcp/pool.ts` | `McpTransportConfig`, transport HTTP, pannes, 404, délai du SDK | 7 |
| `apps/api/src/server.ts`, `mcp/probe.ts`, `evals/run.ts` | passent `transport` au pool | 7, 8 |
| `apps/api/src/evals/types.ts` et voisins | `rag.transport`, `ragLabel` (« tool/http ») | 8 |

## Le parcours dans le code

L'API tourne avec `MCP_TRANSPORT=http`. chloe demande « Qui est la référente télétravail ? ».

1. **Démarrage du serveur** (`index.ts`) : `parseTransport` → `"http"` ; `loadMcpConfig`, la base,
   `createRetriever` ; **`loadHttpTokens`** → `loadMcpTokens(TOKENS_FILE, loadUsers(USERS_FILE))` ;
   **`startHttp({ port, contextFor, auth: createAuthenticator(tokens) })`**.
2. **Démarrage de l'API** (`server.ts`) : **`loadMcpTransport(users)`** →
   `{ kind: "http", url, tokens: Map("chloe" → jeton, …) }` ; `createMcpPool({ transport })`.
3. `/chat` → `loadMcpToolsOrFallback` → **`pool.listTools("chloe")`** → `use` → `attempt` →
   **`getConnection`** → **`connect`** : `httpTransport(url, jetonDeChloe)` puis `client.connect`.
4. Le SDK client envoie **`POST /mcp`** (`initialize`, `Authorization: Bearer …`, sans
   `Mcp-Session-Id`).
5. **`handle`** (`http.ts`) : Host et Origin locaux ; `/mcp` ; **`auth.authenticate`** → identité
   de chloe ; pas de session → `readJson`, `isInitializeRequest` → **`openSession`** :
   `StreamableHTTPServerTransport`, `createRagServer(contextFor(chloe))`, `server.connect`,
   `observeToolCalls`, `transport.handleRequest(req, res, body)`.
6. Le transport crée l'identifiant (`onsessioninitialized`) et le renvoie dans `Mcp-Session-Id`.
   Le client le mémorise, envoie `notifications/initialized` (202), puis `tools/list`.
7. Le modèle demande `mcp__rag__search_documents` → `pool.callTool` → **`POST /mcp`**
   `tools/call` avec `Mcp-Session-Id` → `handle` : jeton, session trouvée, **`sameToken`**,
   `touch`, `session.transport.handleRequest`.
8. L'outil `search_documents` cherche avec les groupes de chloe. `observeToolCalls` voit la
   réponse repartir : `outil search_documents : ok en 361 ms (utilisateur chloe, session 55e74673)`.
9. Cinq minutes sans message : **`closeConnection`** côté API → `terminateSession()` (`DELETE`) →
   `transport.onclose` côté serveur → `session 55e74673 fermée`.

## `apps/mcp-server/src/index.ts` et `config.ts`

### Le choix du transport

```ts
let stop: () => Promise<void>;
if (transport === "stdio") {
  const user = await exitOnError(loadStdioUser);
  stop = await startStdio({ user, pool, retrieve }, config.searchMode, () => void shutdown());
} else {
  const tokens = await exitOnError(loadHttpTokens);
  const port = await exitOnError(loadHttpPort);
  stop = await exitOnError(() =>
    startHttp({
      port,
      searchMode: config.searchMode,
      contextFor: (sessionUser) => ({ user: sessionUser, pool, retrieve }),
      auth: createAuthenticator(tokens),
    }),
  );
}
```

**Ce que fait le code** :
1. Base et recherche sont construites **une fois**, avant le choix du transport.
2. stdio : un utilisateur (`MCP_USER_ID`), un serveur.
3. http : les jetons, le port, et une fonction `contextFor` qui fabrique le contexte d'un
   utilisateur à la demande, une fois par session.
4. Chaque transport renvoie sa fonction d'arrêt ; `shutdown` l'appelle, puis ferme la base.

**Pourquoi** :
- **`contextFor` plutôt qu'un contexte** : en HTTP, l'utilisateur n'est connu qu'à l'arrivée d'un
  jeton. Le transport demande un contexte pour l'utilisateur de la session, sans savoir ce qu'il
  contient.
- **`exitOnError(() => …)`** : il prend une fonction plutôt qu'une promesse, pour attraper aussi
  les erreurs synchrones (`parseTransport`, `loadHttpPort` lèvent une `ConfigError`).
- **`loadMcpConfig` ne lit plus `MCP_USER_ID`** : en HTTP, cette variable n'a pas de sens (ton
  `.env` contient `MCP_USER_ID=alice`, ignoré en HTTP).

## `apps/mcp-server/src/transports/http.ts`

### `handle` : l'ordre des vérifications

```ts
if (!allowedHosts.has(req.headers.host ?? "") || !isLocalOrigin(req.headers.origin)) {
  return sendJson(res, 403, { error: "Hôte ou origine refusés." });
}
// /health, puis /mcp seulement
const identity = auth.authenticate(req.headers.authorization);
if (!identity) { /* 401 */ }
const sessionId = req.headers["mcp-session-id"];
if (typeof sessionId === "string") {
  const session = sessions.get(sessionId);
  if (!session) return sendRpcError(res, 404, "Session inconnue ou expirée : recommence par initialize.");
  if (!sameToken(identity, session.identity)) { /* 403 */ }
  touch(session);
  return session.transport.handleRequest(req, res);
}
```

**Ce que fait le code** : du moins coûteux au plus coûteux, du plus général au plus précis.
1. `Host` doit valoir `127.0.0.1:<port>` ou `localhost:<port>`. `Origin`, s'il est présent, doit
   être local.
2. `/health` répond `{"status":"ok"}`, toute autre route que `/mcp` reçoit un 404.
3. Le jeton, avant de lire quoi que ce soit d'autre.
4. Avec une session : elle doit exister (404) et appartenir à ce jeton (403). Le transport de la
   session traite ensuite la requête, qu'elle soit un POST, un GET ou un DELETE.
5. Sans session : seul un POST `initialize` est accepté.

**Pourquoi** :
- **Host et Origin en premier** : c'est la protection contre le DNS rebinding demandée par la
  spécification. Une page web qui fait pointer `evil.example` vers 127.0.0.1 envoie
  `Host: evil.example:3100` : refusée sans même regarder le jeton. Le SDK proposait une option
  (`allowedHosts`), dépréciée au profit d'un contrôle externe : c'est ce contrôle.
- **Pas d'`Origin` accepté** : curl et les clients Node n'en envoient pas. Seul un navigateur en
  envoie un, et l'Inspector web passe par son propre backend Node.
- **Les erreurs de `/mcp` au format JSON-RPC** (`sendRpcError`) : un client MCP sait les lire. Le
  401 reste un JSON simple, puisqu'on n'a pas encore parlé MCP.

### `openSession`

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  onsessioninitialized: (id) => {
    session.id = id;
    sessions.set(id, session);
    touch(session);
    log(`session ${short(id)} ouverte (utilisateur ${identity.user.id})`);
  },
});
const server = createRagServer(contextFor(identity.user));
const session: Session = { id: "", transport, server, identity, idleTimer: null };
transport.onclose = () => {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (sessions.delete(session.id)) log(`session ${short(session.id)} fermée`);
};
await server.connect(transport);
observeToolCalls(transport, /* … */);
await transport.handleRequest(req, res, body);
```

**Ce que fait le code** :
1. Un transport et un `McpServer` neufs, construits avec l'utilisateur du jeton.
2. L'identifiant n'existe qu'une fois l'`initialize` traité : `onsessioninitialized` range alors
   la session dans la `Map`.
3. `onclose` (DELETE, inactivité ou arrêt) la retire.
4. `handleRequest(req, res, body)` reçoit le corps **déjà lu** : on a dû le lire pour vérifier
   que c'était un `initialize`.

**Pourquoi** :
- **Un serveur par session** : un `McpServer` ne se branche que sur un transport, et ses outils
  capturent leur contexte. Chaque session a donc le sien, avec son utilisateur.
- **`identity` dans la session** : c'est l'empreinte du jeton qui servira au contrôle 403. Le jeton
  en clair n'est gardé nulle part.
- **`if (sessions.delete(...))`** : on ne journalise « fermée » qu'une fois, même si `onclose` est
  appelé pour une session jamais initialisée.

### `touch` et l'arrêt

**Ce que fait le code** : chaque requête relance un minuteur de 30 min (`unref`) qui ferme la
session par `server.close()`. L'arrêt ferme toutes les sessions, puis `closeAllConnections()`, puis
`httpServer.close()`.

**Pourquoi** :
- **L'expiration** : un client peut partir sans `DELETE` (observé avec l'Inspector en ligne de
  commande). Sans minuteur, chaque client parti laisserait un `McpServer` en mémoire indéfiniment.
- **`closeAllConnections`** : un `GET /mcp` (flux de notifications) reste ouvert. Sans cette ligne,
  `httpServer.close()` l'attendrait, et Ctrl+C ne rendrait pas la main (testé avec un flux curl
  ouvert).

### `short`

```ts
function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}
```

**Pourquoi** : 8 caractères suffisent pour suivre une session dans les logs. Ils ne permettent pas
de la reprendre, d'autant que le jeton est de toute façon exigé.

## `apps/mcp-server/src/auth.ts`

### `createAuthenticator`

```ts
const entries = tokens.map(({ token, user }) => ({ digest: sha256(token), user }));

return {
  authenticate(authorization) {
    const token = bearerToken(authorization);
    if (token === null) return null;
    const digest = sha256(token);
    let match: (typeof entries)[number] | null = null;
    for (const entry of entries) {
      if (timingSafeEqual(digest, entry.digest)) match = entry;
    }
    return match ? { user: match.user, digest: match.digest } : null;
  },
};
```

**Ce que fait le code** :
1. Au démarrage, l'empreinte SHA-256 de chaque jeton est calculée une fois.
2. À chaque requête, le jeton est extrait de `Authorization: Bearer <jeton>`, haché, puis comparé
   à toutes les empreintes.
3. L'identité renvoyée porte l'empreinte **du fichier**, réutilisée par `sameToken`.

**Pourquoi** :
- **SHA-256** : `timingSafeEqual` exige deux tampons de même longueur. Comparer les jetons bruts
  obligerait à tester la longueur d'abord, ce qui révélerait la longueur du vrai jeton. Les
  empreintes font toujours 32 octets.
- **Pas de `break`** : sortir à la première correspondance rendrait la réponse plus rapide pour le
  premier jeton du fichier que pour le dernier.
- **`bearerToken`** : le schéma est insensible à la casse (RFC 6750). `Basic …` ou un en-tête sans
  schéma donnent `null`, donc un 401.

## `packages/rag/src/mcp-tokens.ts`

```ts
const tokensSchema = z.record(
  z.string().min(MIN_TOKEN_LENGTH, `un jeton fait au moins ${MIN_TOKEN_LENGTH} caractères`).regex(/^[A-Za-z0-9_-]+$/, "un jeton ne contient que lettres, chiffres, - et _"),
  z.string().min(1),
);
```

```ts
const messages = parsed.error.issues.flatMap((issue) =>
  issue.code === "invalid_key" ? issue.issues.map((inner) => inner.message) : [issue.message],
);
```

**Ce que fait le code** : un objet `{ jeton: userId }`, des clés d'au moins 32 caractères sûrs.
Chaque `userId` doit exister dans `users.json`, et n'avoir qu'un jeton. Le résultat est une liste
`{ token, user }`.

**Pourquoi** :
- **Dans `@chatbot/rag`** : le serveur et l'API lisent le même fichier, avec les mêmes règles.
- **Ne jamais citer un jeton** : Zod met la clé (donc le jeton) dans le chemin de l'erreur, et une
  clé refusée ne donne que « Invalid key in record ». On va chercher les vraies raisons dans les
  sous-erreurs, sans le chemin.
- **Un jeton par utilisateur** : côté API, la table devient `userId → jeton`. Deux jetons pour
  chloe la rendraient ambiguë.
- **L'exemple versionné** a des clés avec espaces (« REMPLACE-MOI par la sortie de : openssl rand
  -hex 32 (alice) ») : copié tel quel, il est refusé au démarrage. Un exemple valide deviendrait le
  jeton connu de tous.

## `apps/mcp-server/src/transports/tool-log.ts`

```ts
const receive = transport.onmessage;
transport.onmessage = (message, extra) => {
  if (isJSONRPCRequest(message) && message.method === "tools/call") {
    const name = message.params?.["name"];
    pending.set(message.id, { tool: typeof name === "string" ? name : "?", startedAt: performance.now() });
  }
  receive?.(message, extra);
};

const send = transport.send.bind(transport);
transport.send = async (message, options) => {
  if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
    // même id qu'une requête tools/call notée : on journalise la durée et le succès
  }
  return send(message, options);
};
```

**Ce que fait le code** : il enveloppe les deux méthodes par lesquelles passent tous les messages
de la session. Une requête `tools/call` entre : on note son id, son outil et l'heure. La réponse au
même id sort : on calcule la durée, et le succès (pas d'erreur JSON-RPC, pas de `isError`).

**Pourquoi** :
- **Sans toucher aux outils** (hors périmètre) : `runTool` ne connaît ni l'utilisateur ni la
  session. Le transport, lui, appartient à une session dont on connaît l'identité.
- **Après `server.connect`** : c'est `connect` qui installe `onmessage`. Enveloppé avant, notre
  version serait écrasée.
- **Une requête annulée n'a pas de ligne** : le SDK n'envoie pas de réponse à une requête annulée
  par le client. Observé pendant l'évaluation : 18 lignes `runTool` pour 15 lignes `outil`, les 3
  manquantes étant les recherches abandonnées après 120 s.

## `apps/api/src/config.ts`

```ts
export async function loadMcpTransport(users: ReadonlyMap<string, User>): Promise<McpTransportConfig> {
  loadDotEnv();
  const kind = process.env["MCP_TRANSPORT"]?.trim() || "stdio";
  if (kind === "stdio") return { kind };
  // … MCP_HTTP_URL validée, puis :
  const tokens = await loadMcpTokens(MCP_TOKENS_FILE, users);
  return { kind, url, tokens: new Map(tokens.map(({ token, user }) => [user.id, token])) };
}
```

**Pourquoi** : en stdio, l'API n'a pas besoin du fichier de jetons. Un fichier absent ne doit donc
pas l'empêcher de démarrer. En HTTP, un fichier invalide l'arrête au démarrage avec un message
clair, plutôt qu'à chaque message.

## `apps/api/src/mcp/pool.ts`

### `connect` : deux transports, une connexion

```ts
if (transportConfig.kind === "stdio") {
  const transport = stdioTransport(userId);
  await client.connect(transport);
  connection.tag = { mcpPid: transport.pid };
} else {
  const token = transportConfig.tokens.get(userId);
  if (token === undefined) throw new Error("aucun jeton MCP pour cet utilisateur (data/mcp-tokens.json)");
  const transport = httpTransport(transportConfig.url, token);
  await client.connect(transport);
  connection.tag = { mcpSession: transport.sessionId?.slice(0, 8) };
  connection.terminate = () => transport.terminateSession();
}
```

**Ce que fait le code** : la seule partie qui dépend du transport. `tag` identifie la connexion dans
les logs (`mcpPid` ou `mcpSession`), `terminate` met fin à la session côté serveur.

**Pourquoi** :
- **`requestInit.headers`** (dans `httpTransport`) : le SDK les ajoute à toutes ses requêtes.
  L'option `authProvider` du SDK sert à OAuth, pas à un jeton statique.
- **Les messages de log stdio inchangés** (`MESSAGES.stdio`) : le cours précédent les cite. En
  HTTP : « session MCP ouverte », « session MCP fermée »…

### `attempt` et `use` : les pannes HTTP

```ts
} catch (error) {
  if (transportConfig.kind === "http" && isHttpFailure(error)) {
    if (!isSessionLost(error)) {
      failedAt.set(userId, Date.now());
      log.warn({ mcpUser: userId, ...connection.tag, reason: describe(error), retryInMs: retryDelayMs }, "serveur MCP injoignable");
    }
    void closeConnection(connection);
  }
  throw error;
}
```

```ts
async function use<T>(userId: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
  try {
    return await attempt(userId, fn);
  } catch (error) {
    if (!isSessionLost(error)) throw error;
    log.info({ mcpUser: userId }, "session MCP perdue côté serveur, nouvelle session");
    return attempt(userId, fn);
  }
}
```

**Ce que fait le code** :
1. `isHttpFailure` : une `StreamableHTTPError` (statut d'erreur du serveur) ou
   `TypeError("fetch failed")` (serveur injoignable). Une `McpError` vient d'un serveur vivant et
   ne ferme rien.
2. Une panne retire la connexion et arme le disjoncteur. Un 404 la retire seulement.
3. `use` donne une seconde chance après un 404 : `attempt` rouvre une session et refait l'appel.

**Pourquoi** :
- **Rien n'arrive par `onclose`** : en stdio, la mort du processus ferme le tuyau, et le SDK le
  dit. En HTTP, il n'y a pas de tuyau. Un serveur arrêté ne se remarque qu'au prochain appel.
- **Le 404 n'arme pas le disjoncteur** : le serveur répond, il a juste oublié la session
  (redémarrage, expiration). La spécification demande au client d'en rouvrir une.
- **`describe`** : le statut HTTP ou le code réseau (`ECONNREFUSED`), jamais le message complet du
  SDK, qui contient le corps de la réponse.

### `closeConnection` et `evict`

```ts
async function closeConnection(connection: Connection): Promise<void> {
  connection.closing = true;
  connection.evict();
  await connection.terminate?.().catch(() => undefined);
  await connection.client.close();
}
```

**Pourquoi** : `evict` retire la connexion du cache **tout de suite**. Avant cette ligne, elle
restait dans la `Map` jusqu'à `onclose`, et la seconde chance de `use` reprenait la connexion
morte : « Connection closed » (bug observé, puis corrigé). Un `DELETE` qui échoue (serveur déjà
arrêté) n'empêche pas de fermer chez nous.

### Le délai du SDK

```ts
const SDK_REQUEST_TIMEOUT_MS = 10 * 60_000;
// …
{ signal, timeout: SDK_REQUEST_TIMEOUT_MS },
```

**Pourquoi** : le SDK coupe toute requête à 60 s par défaut (`DEFAULT_REQUEST_TIMEOUT_MSEC`), sans
regarder notre signal. Le délai voulu est celui du registre : 15 s pour `/chat`, 120 s pour
l'évaluation. Pour l'évaluation, le SDK passait donc avant : une recherche qui attendait le quota de
Voyage pendant 67 s échouait en « indisponible » (q12, premier run stdio). Ce bug datait du cours
précédent et ne dépendait pas du transport.

## L'évaluation

```ts
const mcpTransport = ragMode === "tool" ? await loadMcpTransport(await loadUsers(USERS_FILE)) : null;
if (mcpTransport?.kind === "http") {
  console.error(`  ! MCP en http (${mcpTransport.url.href}) : la recherche suit le RAG_SEARCH_MODE du serveur, lance-le avec ${mode}.`);
}
```

**Ce que fait le code** : le même `MCP_TRANSPORT` que `/chat`. Le run enregistre
`rag: { mode, transport }`, et `ragLabel` l'affiche « tool/http » dans les rapports, `eval:compare`
et l'historique.

**Pourquoi** : en stdio, le pool passe `RAG_SEARCH_MODE` au sous-processus. En HTTP, le serveur
tourne déjà avec son propre mode, et `/health` ne dit rien d'autre que « ok ». On prévient, faute de
pouvoir vérifier.

## Pour explorer toi-même

- **Un échange MCP complet à la main** : les commandes curl des vérifications du cours. Regarde
  les en-têtes de réponse (`curl -i`) : `mcp-session-id` à l'`initialize`, `content-type:
  text/event-stream` sur les requêtes, 202 sur `notifications/initialized`.
- **Le DNS rebinding** : `curl -i -H 'Host: evil.example:3100' http://127.0.0.1:3100/health` → 403 ;
  `-H 'Origin: http://evil.example'` → 403.
- **Le 401 qui déclenche OAuth** : `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3100/mcp --transport http --method tools/list`,
  sans `--header` : l'Inspector répond `auth_required` et cherche à lancer OAuth.
- **Les erreurs de jetons** : copie l'exemple tel quel dans `mcp-tokens.json`, puis un jeton
  `"court"`, puis un utilisateur `zoe`. Chaque fois, le serveur refuse de démarrer et ne cite aucun
  jeton. Remets ensuite tes jetons.
- **Le temps constant, en pratique** : dans `auth.ts`, ajoute un `break` après `match = entry`, puis
  mesure 10 000 `authenticate` avec le premier et le dernier jeton du fichier
  (`performance.now()`). L'écart reste minuscule ici (trois jetons), mais il existe. Retire le
  `break`.
- **Le serveur redémarré** : API en `MCP_TRANSPORT=http`, un message de chloe, Ctrl+C puis relance
  du serveur MCP, nouveau message. Log de l'API : `session MCP perdue côté serveur, nouvelle session`,
  puis une réponse normale.
- **Le serveur arrêté** : même chose sans relancer. Log `serveur MCP injoignable {"reason":"ECONNREFUSED"}`,
  bandeau d'erreur dans le chat, et 30 s de disjoncteur.
- **Le délai du SDK** : remets `{ signal }` sans `timeout` dans `pool.ts`. Une recherche bloquée plus
  de 60 s par le quota Voyage échoue de nouveau en « indisponible ». Remets la ligne.
