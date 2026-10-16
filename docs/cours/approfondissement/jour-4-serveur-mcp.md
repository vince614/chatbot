# Jour 4 · Cours 2 — Le serveur MCP : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-4-serveur-mcp.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Deux chantiers dans ce cours. D'abord un déménagement : le code du RAG quitte `apps/api/src/rag/`
pour un package partagé, `packages/rag` (`@chatbot/rag`), que l'API et le serveur MCP importent.
Ensuite une nouvelle application, `apps/mcp-server`, qui expose deux outils (`search_documents`,
`list_documents`) à n'importe quel client MCP, en transport stdio, au nom d'un utilisateur fixé
au lancement.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `packages/rag/package.json` | `@chatbot/rag`, `exports` avec les conditions `development` / `types` / `default` | 2 |
| `packages/rag/tsconfig.json` | `composite` : un projet que d'autres peuvent référencer (`tsc -b`) | 2 |
| `packages/rag/src/env.ts` | `ConfigError`, `loadDotEnv(file)`, `requireEnv` : le package ne connaît aucun chemin | 2, 10 |
| `packages/rag/src/config.ts` | `loadDatabaseConfig`, `loadEmbeddingConfig`, `loadSearchMode` (déplacés, inchangés) | 2 |
| `packages/rag/src/users.ts` | `loadUsers(file)`, `requireUser(file, id, source)` | 4 |
| `packages/rag/src/db/repository.ts` | `listVisibleDocuments` : les documents visibles, filtrés en SQL | 4, 5 |
| `packages/rag/src/db/migrate.ts`, `packages/rag/migrations/*.sql` | `MIGRATIONS_DIR` relatif au module | 2 |
| `packages/rag/src/{retrieve,acl,document}.ts`, `db/`, `embeddings/`, `pdf/`, `text/` | le RAG, déplacé par `git mv` sans changement de logique | 2 |
| `apps/api/src/config.ts` | `ENV_FILE`, `PDF_DIR`, `ACL_FILE`, `USERS_FILE`, et les enveloppes des loaders | 2 |
| `apps/api/package.json`, `apps/api/tsconfig.json` | `tsx --conditions=development`, `references`, typecheck en deux temps | 2 |
| `apps/mcp-server/package.json`, `tsconfig.json` | dépendances (`@modelcontextprotocol/sdk`, `zod`), script `mcp`, `references` | 1, 2, 3 |
| `apps/mcp-server/src/index.ts` | le démarrage : config, base, outils, transport, arrêt | 0, 1, 3, 10 |
| `apps/mcp-server/src/config.ts` | `loadMcpConfig` : `.env` et annuaire de l'API, `MCP_USER_ID` | 4, 10 |
| `apps/mcp-server/src/log.ts` | `log` sur stderr, `redirectConsoleToStderr` | 3 |
| `apps/mcp-server/src/tools/shared.ts` | `ToolContext`, `runTool` : exception → `isError` avec message public | 4, 7 |
| `apps/mcp-server/src/tools/search-documents.ts` | l'outil de recherche : description, schémas, annotations | 5, 6, 7 |
| `apps/mcp-server/src/tools/list-documents.ts` | l'outil de liste, sans argument | 5, 6 |
| `package.json` (racine), `.mcp.json` | `npm run --silent mcp`, le serveur `chatbot-rag` déclaré pour Claude Code | 8, 9 |

## Le parcours dans le code

Claude Code lit `.mcp.json` et lance le serveur `chatbot-rag` avec `MCP_USER_ID=chloe`. Le modèle
appelle ensuite `search_documents` avec la question q06.

1. **`npm run --silent mcp`** (racine) → **`npm run --silent mcp -w apps/mcp-server`** →
   **`tsc -b 1>&2`** : compile `packages/rag` puis `apps/mcp-server` (les `references`), sorties sur
   stderr. Puis **`node dist/index.js`**, sans condition : `@chatbot/rag/*` se résout vers `dist/*.js`.
2. **`index.ts`** : `redirectConsoleToStderr()` en tout premier.
3. **`loadConfigOrExit()`** → **`exitOnError(loadMcpConfig())`** (`config.ts`) :
   `loadDotEnv(ENV_FILE)` charge `apps/api/.env` ; `requireUser(USERS_FILE, "chloe", "MCP_USER_ID")`
   → `loadUsers` lit et valide `users.json` ; puis `loadDatabaseConfig`, `loadEmbeddingConfig`,
   `loadSearchMode` (chacun via `requireEnv`). Une `ConfigError` ici : message sur stderr, `exit 1`.
4. **`createPool`**, puis **`assertEmbeddingDimension`** (toujours via `exitOnError`) : la base
   répond et `chunks.embedding` a la bonne dimension.
5. **`createRetriever({ pool, embedder: createEmbeddingClient(…), defaultMode })`** : la même
   fonction `retrieve` que l'API.
6. **`new McpServer(…)`**, **`registerSearchDocuments(server, context)`**,
   **`registerListDocuments(server, context)`** : les outils sont enregistrés avec leurs schémas ;
   `context` contient `user`, `pool`, `retrieve`.
7. **`server.connect(new StdioServerTransport())`** : le SDK lit stdin, écrit sur stdout.
   `log("prêt (utilisateur chloe, recherche vector)")` sur stderr.
8. Le client envoie `initialize`, puis `tools/list` : le SDK répond seul, à partir des schémas Zod
   convertis en JSON Schema.
9. **`tools/call search_documents`** `{ question: "Je bosse depuis mon salon…" }` : le SDK valide
   les arguments (`validateToolInput` : `trim`, longueur, `k` absent → 5), puis appelle le handler.
10. **`runTool("search_documents", …)`** → **`retrieve(question, { userGroups: ["rh", "tech"], k: 5 })`** :
    embedding Voyage de la question, requête SQL filtrée par `&&`, 5 chunks.
11. Le handler fabrique `passages` (`range`, score arrondi) et le texte `[1] reglement-interieur.pdf, p. 3 (score 0.411)…`,
    renvoie `content` + `structuredContent`. `runTool` écrit `search_documents : ok en … ms` sur stderr.
12. Le SDK vérifie `structuredContent` contre `outputSchema` (`validateToolOutput`), puis le
    transport écrit **une ligne JSON** sur stdout. Le client la remet au modèle.

## `packages/rag/package.json` et `tsconfig.json`

### Les `exports` et leurs conditions

```json
  "exports": {
    "./*": {
      "development": "./src/*.ts",
      "types": "./dist/*.d.ts",
      "default": "./dist/*.js"
    }
  },
```

**Ce que fait le code** : `"./*"` ouvre tous les modules du package par leur chemin, sans
extension : `import { createPool } from "@chatbot/rag/db/pool"`. Pour chaque import, le résolveur
parcourt les conditions **dans l'ordre** et prend la première qu'il reconnaît :

| Qui résout | Conditions actives | Fichier obtenu |
| --- | --- | --- |
| `tsx --conditions=development` (scripts de `apps/api`) | `development`, `import`, `node`… | `src/db/pool.ts` |
| `node dist/index.js` (serveur MCP) | `import`, `node`, `default` | `dist/db/pool.js` |
| `tsc` (`moduleResolution: NodeNext`) | `types`, `import`, `node`… | `dist/db/pool.d.ts` |

`@chatbot/rag` est trouvé dans `node_modules` grâce aux workspaces npm : `node_modules/@chatbot/rag`
est un lien symbolique vers `packages/rag`. La version `"0.1.0"` dans les dépendances des apps
désigne ce workspace.

**Pourquoi** :
- **`development` en premier** : en développement, l'API lit directement les sources TypeScript.
  Modifier `retrieve.ts` suffit, sans build, et `tsx watch` recharge.
- **`default` vers `dist`** : `node` ne sait pas exécuter du `.ts`. Le serveur MCP est lancé par
  `node`, donc il lui faut le JavaScript compilé.
- **`types` vers `dist/*.d.ts`** : `tsc` ne connaît pas la condition `development` (aucune
  `customConditions` n'est déclarée). Il lit les déclarations générées, d'où l'obligation de
  compiler le package **avant** de vérifier une app (plus bas : `tsc -b`).

### `composite` et les `references`

```json
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
```

**Ce que fait le code** : `composite` fait de `packages/rag` un projet **référençable**. `tsc -b`
le compile dans `dist/` (`.js`, `.d.ts`, cartes) et note l'état dans `tsconfig.tsbuildinfo`
(ignoré par git) pour ne recompiler que ce qui a changé. Côté apps, une ligne suffit :

```json
  "include": ["src"],
  "references": [{ "path": "../../packages/rag" }]
```

(`apps/mcp-server/tsconfig.json` ; `apps/api/tsconfig.json` a la même référence, écrite sur
plusieurs lignes.)

**Pourquoi** :
- **`tsc -b` suit les références** : `tsc -b` dans `apps/mcp-server` compile d'abord le package,
  puis l'app, chacun seulement s'il est périmé. Un seul ordre, toujours le bon.
- **`declarationMap`** : « aller à la définition » dans l'éditeur ouvre `src/retrieve.ts`, pas
  `dist/retrieve.d.ts`.
- **`apps/api` n'émet rien** : son script `typecheck` vaut `tsc -b ../../packages/rag && tsc --noEmit`.
  Le package est construit (pour ses `.d.ts`), puis l'API est seulement vérifiée : elle tourne avec
  `tsx`, elle n'a pas besoin de `dist/`.

## `packages/rag/src/env.ts`

### `ConfigError`

```ts
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}
```

**Ce que fait le code** : une erreur dont le **message est destiné à un humain**, affiché tel quel,
sans pile. Elle vivait dans `apps/api/src/config.ts` ; le package la lance désormais lui-même
(`requireEnv`, `loadUsers`, `requireUser`, `loadAcl`, `assertEmbeddingDimension`).

**Pourquoi** : `instanceof ConfigError` doit marcher dans l'API **et** dans le serveur MCP. Une seule
classe, dans le package que les deux importent. `apps/api/src/config.ts` la réexporte
(`export { ConfigError } from "@chatbot/rag/env";`) : les imports existants de l'API n'ont pas bougé.

### `loadDotEnv(file)` et `requireEnv`

```ts
let envFile: string | undefined;

/** Charge un fichier .env dans process.env. Un fichier absent est toléré. */
export function loadDotEnv(file: string): void {
  envFile = file;
  try {
    loadEnvFile(file);
  } catch (error) {
    // Fichier absent : on tolère, les variables peuvent venir de l'environnement.
    if (!isFileNotFound(error)) throw error;
  }
}
```

```ts
export function requireEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      [
        `Variable(s) d'environnement manquante(s) : ${missing.join(", ")}.`,
        envFile
          ? `Renseigne-les dans ${envFile} (modèle : .env.example à côté).`
          : "Aucun fichier .env n'a été lu : renseigne-les dans l'environnement.",
      ].join("\n"),
    );
  }
}
```

**Ce que fait le code** :
1. `loadDotEnv` reçoit **le chemin** du `.env`, le mémorise dans `envFile`, et le charge avec
   `loadEnvFile` de `node:process` (Node ≥ 20.12, sans dépendance `dotenv`). `ENOENT` est avalé,
   toute autre erreur (fichier mal formé, droits) remonte.
2. `requireEnv` liste **toutes** les variables absentes ou vides d'un coup et cite le fichier lu.

**Pourquoi** : avant, le chemin `apps/api/.env` était calculé dans le module de config. Dans un
package partagé, ce chemin n'a plus de sens : le package ne sait pas qui l'utilise. **L'application
donne ses chemins** (`.env`, `users.json`, `acl.json`), le package lit. `envFile` sert seulement le
message d'erreur : un serveur MCP mal configuré dit « renseigne-les dans `…/apps/api/.env` », pas
une phrase vague.

## `packages/rag/src/users.ts`

### `requireUser(file, id, source)`

```ts
export async function requireUser(file: string, id: string | undefined, source = "--user"): Promise<User> {
  const users = await loadUsers(file);
  const user = id === undefined ? undefined : users.get(id);
  if (!user) {
    const known = [...users.keys()].join(", ");
    throw new ConfigError(
      id === undefined ? `${source} est obligatoire (${known}).` : `Utilisateur inconnu : « ${id} » (${known}).`,
    );
  }
  return user;
}
```

**Ce que fait le code** :
1. `loadUsers(file)` lit et valide l'annuaire (Zod : identifiants uniques, groupes bien formés).
2. Pas d'identifiant → « `<source>` est obligatoire » ; identifiant inconnu → « Utilisateur
   inconnu ». Dans les deux cas, les identifiants connus sont listés.

Observé avec le serveur MCP :

```text
[mcp] MCP_USER_ID est obligatoire (alice, bruno, chloe).
[mcp] Utilisateur inconnu : « zoe » (alice, bruno, chloe).
```

**Pourquoi** :
- **`file` en premier argument** : même règle que `loadDotEnv`, le package ne connaît pas
  `apps/api/data/users.json`.
- **`source`** : le même contrôle sert deux interfaces. Les scripts (`search.ts`, `ask.ts`,
  `evals/run.ts`) appellent `requireUser(USERS_FILE, values.user)` et gardent « --user » par
  défaut ; le serveur MCP passe `"MCP_USER_ID"`. Le message nomme ce que l'utilisateur doit
  corriger, pas un paramètre interne.
- **Pas d'utilisateur par défaut** : un serveur qui partirait en « chloe » faute de mieux donnerait
  les droits RH à quiconque oublie la variable (leçon 4).

## `packages/rag/src/db/repository.ts`

### `listVisibleDocuments`

```ts
export async function listVisibleDocuments(pool: pg.Pool, userGroups: readonly string[]): Promise<VisibleDocument[]> {
  if (userGroups.length === 0) return [];
  const { rows } = await pool.query<{ file_name: string; pages: number; ingested_at: Date }>(
    `SELECT d.file_name, COALESCE(MAX(c.page_end), 0)::int AS pages, d.ingested_at
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.allowed_groups && $1::text[]
     GROUP BY d.id
     ORDER BY d.file_name`,
    [userGroups],
  );
  return rows.map((row) => ({ fileName: row.file_name, pages: row.pages, ingestedAt: row.ingested_at }));
}
```

**Ce que fait le code** :
1. Aucun groupe → liste vide, sans requête.
2. Un document par ligne (`GROUP BY d.id`), avec `MAX(page_end)` de ses chunks comme nombre de pages.
   `LEFT JOIN` + `COALESCE(…, 0)` : un document sans chunk apparaît avec 0 page au lieu de disparaître.
3. **`WHERE d.allowed_groups && $1::text[]`** : le même opérateur « au moins un groupe en commun »
   que les deux requêtes de recherche (jour 3).
4. Tri par nom, puis renommage en camelCase (`VisibleDocument`).

**Pourquoi** :
- **Le filtre est dans le `WHERE`** : un document interdit ne sort jamais de Postgres, **pas même
  son nom**. Avec bruno, la liste ne contient que `discordinvites.pdf` (4 pages) ; avec alice, que
  `reglement-interieur.pdf` (5 pages). Lister puis filtrer en JavaScript ferait transiter les noms
  interdits par le serveur, à un `console.log` d'une fuite.
- **`MAX(page_end)` plutôt qu'un nombre de pages** : la base ne stocke pas le nombre de pages du
  PDF. Le commentaire de `VisibleDocument.pages` le dit : c'est la dernière page qui contient du texte.

## `packages/rag/src/db/migrate.ts`

```ts
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
```

**Ce que fait le code** : `import.meta.url` est l'URL du module en cours. Depuis
`packages/rag/src/db/migrate.ts` comme depuis `packages/rag/dist/db/migrate.js`, `../../` remonte à
`packages/rag/`, et le dossier visé est `packages/rag/migrations/`.

**Pourquoi** : les `.sql` ne sont pas du TypeScript, `tsc` ne les copie pas dans `dist/`. On les a
donc sortis de `src/` (ils étaient dans `apps/api/src/rag/db/migrations/`) vers un dossier à la
racine du package, **à égale distance** de `src/db/` et de `dist/db/`. Le même calcul marche que
le module soit lu par `tsx` (sources) ou par `node` (build). Le serveur MCP fait la même chose dans
son `config.ts`.

## `apps/api/src/config.ts`

### Les chemins de l'API

```ts
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
```

```ts
export const PDF_DIR = fileURLToPath(new URL("../data/pdfs/", import.meta.url));

/** Les droits d'accès aux PDF (voir @chatbot/rag/acl). */
export const ACL_FILE = `${PDF_DIR}acl.json`;

/** L'annuaire des utilisateurs fictifs (voir @chatbot/rag/users). */
export const USERS_FILE = fileURLToPath(new URL("../data/users.json", import.meta.url));
```

**Ce que fait le code** : tous les chemins de l'API, calculés depuis `apps/api/src/config.ts`,
indépendants du répertoire courant. Les scripts les passent au package :
`requireUser(USERS_FILE, values.user)`, `loadAcl(ACL_FILE)`.

**Pourquoi** : ce que le package a perdu (les chemins), l'application l'a gagné, **à un seul
endroit**. Déplacer `users.json` se corrige ici, pas dans le RAG.

### Les enveloppes des loaders

```ts
import * as rag from "@chatbot/rag/config";
import { loadDotEnv as loadEnvFile, requireEnv } from "@chatbot/rag/env";
```

```ts
export function loadDotEnv(): void {
  loadEnvFile(ENV_FILE);
}
```

```ts
export function loadDatabaseConfig(): rag.DatabaseConfig {
  loadDotEnv();
  return rag.loadDatabaseConfig();
}
```

**Ce que fait le code** : l'API garde **sa** fonction `loadDotEnv()`, sans argument, qui appelle
celle du package (renommée `loadEnvFile` à l'import pour éviter le conflit de noms) avec `ENV_FILE`.
`loadDatabaseConfig`, `loadEmbeddingConfig` et `loadSearchMode` suivent le même schéma : charger le
`.env` de l'API, puis lire `process.env` via le package (`rag.` préfixe les originaux).

**Pourquoi** : avant le déménagement, `loadDatabaseConfig()` chargeait le `.env` lui-même. Les
scripts de l'API (`migrate.ts`, `ingest.ts`, `search.ts`…) l'appellent toujours sans argument : avec
ces enveloppes, ils n'ont changé que leurs imports. Le package, lui, reste pur : il lit
`process.env`, et c'est l'app qui décide d'où viennent les variables.

## `apps/api/package.json`

```json
    "dev": "tsx watch --conditions=development src/server.ts",
    "hello": "tsx --conditions=development src/hello.ts",
    "typecheck": "tsc -b ../../packages/rag && tsc --noEmit",
```

**Ce que fait le code** : chaque script ajoute `--conditions=development` à `tsx`, qui le transmet
au résolveur de Node. `@chatbot/rag/retrieve` devient `packages/rag/src/retrieve.ts`.

**Pourquoi** : sans le drapeau, `tsx` prendrait `default` → `dist/retrieve.js`, c'est-à-dire la
**dernière version compilée**, peut-être périmée ou absente. Avec, l'API tourne toujours sur les
sources, comme avant le déménagement.

## `apps/mcp-server/package.json`

```json
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b",
    "mcp": "tsc -b 1>&2 && node dist/index.js"
  },
  "dependencies": {
    "@chatbot/rag": "0.1.0",
    "@modelcontextprotocol/sdk": "^1.32.1",
    "zod": "^4.6.6"
  }
```

**Ce que fait le code** : `npm run mcp` compile (package puis serveur, grâce aux `references`), puis
lance `node dist/index.js`. La racine relaie : `"mcp": "npm run --silent mcp -w apps/mcp-server"`.

**Pourquoi** :
- **`node`, pas `tsx`** : un serveur lancé par un client (Claude Code, l'Inspector) doit démarrer
  vite et de façon prévisible, sur du code vérifié par `tsc`. Une erreur de type empêche le
  lancement au lieu d'exploser au premier appel.
- **`1>&2`** : `tsc` écrit ses diagnostics sur **stdout**. Une erreur de compilation enverrait du
  texte au client, qui attend du JSON-RPC (leçon 3). Redirigée, elle part sur stderr, que le client
  affiche comme un log.
- **`--silent`, deux fois** : sans lui, `npm run` imprime son bandeau (`> chatbot@0.1.0 mcp`) sur
  stdout, avant la réponse JSON : le client reçoit une ligne qui n'est pas du JSON. `.mcp.json`
  passe `--silent` à l'appel racine, le script racine le passe à l'appel du workspace.
- **`zod` 4** : le SDK accepte des schémas Zod et les convertit en JSON Schema pour `tools/list`.

## `apps/mcp-server/src/log.ts`

```ts
export function log(message: string): void {
  console.error(`[mcp] ${message}`);
}
```

```ts
export function redirectConsoleToStderr(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}
```

**Ce que fait le code** : `log` écrit sur stderr avec un préfixe `[mcp]`. `redirectConsoleToStderr`
remplace les trois méthodes de `console` qui écrivent sur stdout par `console.error`.

**Pourquoi** :
- **stdout appartient au protocole** (leçon 3). Chaque ligne y est lue comme un message JSON-RPC ;
  un `console.log("ok")` est un message invalide pour le client.
- **Le filet attrape tout le processus** : un `console.log` oublié ici, dans `@chatbot/rag` ou dans
  une dépendance. `console` est un objet global, le remplacer une fois suffit.
- **Le transport n'est pas touché** : `StdioServerTransport` écrit avec `process.stdout.write`
  (dans `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js`), pas avec `console.log`.
- **`console.warn` n'est pas dans la liste** : il écrit déjà sur stderr.

## `apps/mcp-server/src/config.ts`

### Les chemins vers l'API

```ts
const API_DIR = new URL("../../api/", import.meta.url);
const ENV_FILE = fileURLToPath(new URL(".env", API_DIR));
const USERS_FILE = fileURLToPath(new URL("data/users.json", API_DIR));
```

**Ce que fait le code** : depuis `apps/mcp-server/src/config.ts` ou `apps/mcp-server/dist/config.js`,
`../../` mène à `apps/`, puis `api/`. Le serveur lit `apps/api/.env` et `apps/api/data/users.json`.

**Pourquoi** : **une seule copie de chaque secret**. La clé Voyage et `DATABASE_URL` restent dans le
`.env` de l'API ; l'annuaire aussi. Un second `.env` dans `apps/mcp-server` finirait par diverger
(une clé renouvelée d'un côté seulement). Même profondeur depuis `src/` et `dist/` : même calcul.

### `loadMcpConfig()`

```ts
export async function loadMcpConfig(): Promise<McpConfig> {
  loadDotEnv(ENV_FILE);
  // MCP_USER_ID vient de l'environnement du processus (Inspector, .mcp.json),
  // jamais d'un argument d'outil : l'identité est fixée au lancement.
  const user = await requireUser(USERS_FILE, process.env["MCP_USER_ID"]?.trim() || undefined, "MCP_USER_ID");
  return {
    user,
    database: loadDatabaseConfig(),
    embedding: loadEmbeddingConfig(),
    searchMode: loadSearchMode(),
  };
}
```

**Ce que fait le code** :
1. Charge le `.env` de l'API dans `process.env`.
2. **L'identité d'abord** : `MCP_USER_ID`, nettoyé ; une chaîne vide (`MCP_USER_ID=`) devient
   `undefined` grâce à `|| undefined`, donc « est obligatoire » plutôt que « inconnu : « » ».
3. Puis la base, Voyage et le mode de recherche, chacun pouvant lancer une `ConfigError`.

**Pourquoi** :
- **L'identité est une propriété du processus** (leçon 4). Elle vient de l'environnement, posé par
  celui qui lance le serveur (`.mcp.json`, `-e` de l'Inspector), pas du modèle. Aucun outil n'a
  d'argument `user` : une injection de prompt ne peut pas demander « cherche en tant que chloe ».
- **D'abord l'identité** : sans utilisateur valide, inutile de vérifier le reste. Le message
  d'erreur le plus probable sort en premier.
- **Les loaders du package, sans enveloppe** : le serveur charge son `.env` une fois, ici, puis
  appelle directement `loadDatabaseConfig` & co. Les enveloppes de l'API n'ont pas lieu d'être.

## `apps/mcp-server/src/index.ts`

### Le démarrage, en quatre temps

```ts
redirectConsoleToStderr();

// 1. Configuration et identité : en cas d'échec, on s'arrête avant d'ouvrir
//    le transport. Le client voit un processus terminé et le message sur stderr.
const config = await loadConfigOrExit();
const { user } = config;
```

```ts
const pool = createPool(config.database.databaseUrl);
pool.on("error", (error) => log(`connexion Postgres perdue : ${error.message}`));
await exitOnError(assertEmbeddingDimension(pool, config.database.embeddingDimension));
const retrieve = createRetriever({
  pool,
  embedder: createEmbeddingClient(config.embedding),
  defaultMode: config.searchMode,
});
```

```ts
const server = new McpServer({ name: "chatbot-rag", version: "0.1.0" });
const context = { user, pool, retrieve };
registerSearchDocuments(server, context);
registerListDocuments(server, context);

// 4. Le transport stdio : à partir d'ici, stdout appartient au protocole.
await server.connect(new StdioServerTransport());
// L'identifiant seulement : les groupes n'ont rien à faire dans les logs.
log(`prêt (utilisateur ${user.id}, recherche ${config.searchMode})`);
```

**Ce que fait le code**, dans l'ordre du fichier (un module ESM : `await` au niveau racine) :
1. **Le filet** sur `console`, avant toute autre instruction.
2. **La config** (identité comprise), ou arrêt.
3. **La base** : un pool, un écouteur `error`, la vérification de `chunks.embedding` (qui prouve au
   passage que Postgres répond), puis `retrieve`, **la même fabrique que l'API**.
4. **Le serveur** : nom et version (renvoyés dans `serverInfo` à `initialize`), puis les deux
   outils, qui reçoivent le même `context`.
5. **Le transport** : `connect` branche stdin/stdout, et le log « prêt » part sur stderr.

Observé avec chloe, en envoyant `initialize` sur stdin : une seule ligne sur stdout,

```text
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"chatbot-rag","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

et, sur stderr, `[mcp] prêt (utilisateur chloe, recherche vector)`.

**Pourquoi** :
- **Échouer au démarrage, pas à l'appel** (leçon 10). Une base injoignable ou une mauvaise dimension
  arrête le processus avant `connect` : le client voit un serveur qui ne démarre pas, avec le
  message dans ses logs. Sinon chaque appel d'outil échouerait, plus loin de la cause.
- **Rien sur stdout avant `connect`** : sans `MCP_USER_ID`, on a mesuré **0 octet** sur stdout,
  le message sur stderr et le code de sortie 1.
- **`pool.on("error")`** : `pg` émet `error` sur le pool quand une connexion **inactive** casse
  (Postgres redémarré). Un événement `error` sans écouteur fait tomber le processus Node ; ici, il
  devient une ligne de log, et la prochaine requête ouvre une nouvelle connexion.
- **`user.id` seulement dans le log** : les groupes décrivent les droits de quelqu'un ; les logs
  n'en ont pas besoin pour diagnostiquer.

### L'arrêt

```ts
const shutdown = async (): Promise<void> => {
  await server.close();
  await pool.end();
  process.exit(0);
};
process.stdin.on("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
```

**Ce que fait le code** : ferme le serveur MCP, puis le pool (sinon Node attend les connexions
ouvertes et ne s'arrête jamais), puis quitte. `void` marque la promesse comme volontairement ignorée.

**Pourquoi** : en stdio, **le client possède le processus**. Il l'arrête en fermant stdin (fin de
session) ou par un signal. Les trois déclencheurs mènent au même arrêt propre.

### `exitOnError()` et `describe()`

```ts
async function exitOnError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    log(error instanceof ConfigError ? error.message : `démarrage impossible : ${describe(error)}`);
    process.exit(1);
  }
}
```

```ts
function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors[0] instanceof Error) return error.errors[0].message;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
```

**Ce que fait le code** :
1. Attend la promesse et rend sa valeur ; en cas d'échec, un message sur stderr et `exit 1`.
2. Une `ConfigError` s'affiche **telle quelle** (elle est écrite pour un humain). Toute autre erreur
   est préfixée par `démarrage impossible :`, **sans pile**.
3. `describe` garantit un message non vide : une `AggregateError` prend le message de sa première
   erreur ; une erreur sans message, son nom.

Observé avec `DATABASE_URL` vers un port fermé :

```text
[mcp] démarrage impossible : connect ECONNREFUSED ::1:5499
```

**Pourquoi** :
- **L'`AggregateError`** : quand `localhost` désigne à la fois IPv6 et IPv4, Node essaie les deux
  adresses et, si toutes échouent, rejette avec une `AggregateError`… dont le `message` est vide.
  Sans `describe`, le log disait `démarrage impossible : ` et rien d'autre. Le détail utile est
  dans `error.errors`.
- **Sans pile** : la pile d'une erreur de connexion pointe dans `pg`, elle n'aide pas l'étudiant.
  Le message (`ECONNREFUSED`, le port) dit quoi corriger.
- **Générique** (`<T>`) : la même fonction enveloppe `loadMcpConfig()` (qui rend la config) et
  `assertEmbeddingDimension` (qui ne rend rien).

## `apps/mcp-server/src/tools/shared.ts`

### `ToolContext`

```ts
export interface ToolContext {
  user: User;
  pool: ReturnType<typeof createPool>;
  retrieve: Retrieve;
}
```

**Ce que fait le code** : ce que reçoit chaque fonction `register…`, fixé au démarrage. Chaque outil
déstructure ce dont il a besoin : `{ user, retrieve }` pour la recherche, `{ user, pool }` pour la liste.

**Pourquoi** : l'utilisateur est **dans le contexte, pas dans les arguments**. Le modèle choisit
`question` et `k` ; il ne choisit pas qui il est.

### `runTool()`

```ts
export async function runTool(
  name: string,
  publicMessage: string,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const start = performance.now();
  try {
    const result = await run();
    log(`${name} : ok en ${Math.round(performance.now() - start)} ms`);
    return result;
  } catch (error) {
    log(`${name} : échec en ${Math.round(performance.now() - start)} ms : ${error instanceof Error ? error.message : error}`);
    return { isError: true, content: [{ type: "text", text: publicMessage }] };
  }
}
```

**Ce que fait le code** :
1. Chronomètre l'outil.
2. Succès : une ligne `ok en … ms` sur stderr, le résultat inchangé.
3. Exception : une ligne `échec` **avec le détail technique** sur stderr, et un résultat
   `isError: true` qui ne contient que `publicMessage`.

Observé avec une clé Voyage invalide, sur stderr :

```text
[mcp] search_documents : échec en 248 ms : Voyage a répondu HTTP 401 : {"detail":"Provided API key is invalid."}
```

et, pour le modèle : `La recherche a échoué (base ou service d'embeddings indisponible). Réessaie plus tard.`
L'appel `list_documents` suivant fonctionne : le serveur a continué.

**Pourquoi** :
- **Le SDK convertit déjà les exceptions** : dans `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`,
  le `catch` du handler `tools/call` appelle `createToolError(error.message)`, qui renvoie
  `{ content: [{ type: "text", text: errorMessage }], isError: true }`. Sans `runTool`, le serveur
  ne planterait pas, mais **le modèle lirait le message brut** : code HTTP, réponse de Voyage, demain
  un nom d'hôte Postgres. `runTool` sépare les publics : le détail pour l'humain qui lit les logs,
  une phrase actionnable pour le modèle (leçon 7).
- **`isError` plutôt qu'une erreur JSON-RPC** : une erreur de protocole dit « le client s'est trompé » ;
  `isError` est un **résultat** que le modèle lit et peut traiter (prévenir l'utilisateur, réessayer).
- **Ni question ni groupes dans les logs** : le nom de l'outil, la durée, l'erreur. Une question peut
  contenir une donnée personnelle ; les logs vivent plus longtemps qu'une conversation.
- **Les erreurs de validation ne passent pas par ici** : le SDK valide les arguments **avant**
  d'appeler le handler. `k: 20` donne un `isError` produit par le SDK
  (`MCP error -32602: Input validation error: Invalid arguments for tool search_documents: Too big: expected number to be <=10 at k`),
  sans ligne `[mcp] search_documents : …` sur stderr, et sans appel à Voyage.

## `apps/mcp-server/src/tools/search-documents.ts`

### La description

```ts
const DESCRIPTION = `Cherche dans les documents internes de l'entreprise les passages les plus pertinents pour une question, parmi les documents que l'utilisateur a le droit de lire. Renvoie pour chaque passage le fichier, les pages, le texte et un score.
```

(La constante continue sur trois paragraphes : quand l'utiliser, quand ne pas l'utiliser, comment
répondre avec les passages.)

**Ce que fait le code** : le texte que le client montre au modèle dans `tools/list`. Il dit ce que
fait l'outil, ce qu'il renvoie, **quand** l'appeler (règles internes, procédures, identifiants
techniques ; une recherche par sujet pour une question double), quand **ne pas** l'appeler, et
comment s'en servir (répondre à partir des passages, citer, dire quand les documents ne répondent pas).

**Pourquoi** (leçon 6) :
- **C'est le seul texte qui décide le modèle** à appeler l'outil : il ne voit pas le code.
- **Aucun nom de document** : la description est la même pour tous les utilisateurs. Écrire
  « le règlement intérieur RH » apprendrait à bruno qu'un document RH existe. Les catégories
  (« avantages des salariés ») restent génériques.
- **Les consignes de réponse** reprennent celles du prompt RAG de l'API : un client MCP n'a pas
  notre prompt système, la description le remplace en partie.

### Les schémas et les annotations

```ts
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("La question ou les mots-clés à chercher, en langage naturel, avec les termes exacts."),
        k: z
          .number()
          .int()
          .min(1)
          .max(MAX_K)
          .default(DEFAULT_K)
          .describe(`Nombre de passages à renvoyer (1 à ${MAX_K}, ${DEFAULT_K} par défaut).`),
      },
      outputSchema: { passages: z.array(passageSchema) },
      // Indications pour le client : l'outil ne modifie rien et ne sort pas du système d'information.
      annotations: { readOnlyHint: true, openWorldHint: false },
```

**Ce que fait le code** :
1. **`inputSchema`** : un objet de champs Zod. Le SDK en tire le JSON Schema de `tools/list` et
   valide chaque appel. `.trim()` **transforme** avant de vérifier : `"   "` devient `""`, refusé
   par `.min(1)` (`Too small: expected string to have >=1 characters at question`).
   `.default(DEFAULT_K)` rend `k` facultatif (5).
2. **`outputSchema`** : la forme de `structuredContent`, `{ passages: [{ fichier, pages, extrait, score }] }`
   (`passageSchema` juste au-dessus).
3. **`annotations`** : lecture seule, monde fermé.

**Pourquoi** :
- **`MAX_K = 10`**, plus strict que les 50 de `retrieve` : chaque passage pèse environ 500 tokens
  dans le contexte du modèle. Au-delà de 10, il paie pour des passages peu pertinents.
- **`.describe()` sur chaque champ** : la description du champ va dans le JSON Schema ; c'est elle
  qui dit au modèle de garder les termes exacts (`ns338233`), utiles à la recherche hybride.
- **La validation avant le handler** : le code du handler reçoit un `k` entier entre 1 et 10, sans
  recontrôler. `retrieve` revérifie de son côté : il sert aussi l'API.
- **Les annotations sont des indications**, pas des garanties : un client peut s'en servir pour ne
  pas demander de confirmation avant un outil en lecture seule. Elles ne protègent rien.

### Le handler

```ts
    ({ question, k }) =>
      runTool("search_documents", "La recherche a échoué (base ou service d'embeddings indisponible). Réessaie plus tard.", async () => {
        // Les groupes viennent de l'identité du serveur, jamais des arguments.
        const chunks = await retrieve(question, { userGroups: user.groupes, k });
        const passages = chunks.map((chunk) => ({
          fichier: chunk.fileName,
          pages: range(chunk.pageStart, chunk.pageEnd),
          extrait: chunk.content,
          score: Math.round(chunk.score * 1000) / 1000,
        }));
```

```ts
        const text =
          passages.length === 0
            ? "Aucun passage trouvé dans les documents accessibles à cet utilisateur."
            : chunks
                .map((chunk, i) => `[${i + 1}] ${chunk.fileName}, ${formatPages(chunk)} (score ${passages[i]!.score})\n${chunk.content}`)
                .join("\n\n");
        // content : le texte que lit le modèle. structuredContent : les mêmes
        // données, typées par outputSchema, pour un client qui les traite.
        return { content: [{ type: "text", text }], structuredContent: { passages } };
```

```ts
function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
```

**Ce que fait le code** :
1. `retrieve` avec **`user.groupes`** (du contexte) et `k` (des arguments) : le mode vient de
   `RAG_SEARCH_MODE`, comme dans l'API.
2. Chaque chunk devient un passage : `pages` en liste (`range(2, 3)` → `[2, 3]`), score à trois
   décimales.
3. Le texte pour le modèle : un bloc numéroté par passage, `[1] reglement-interieur.pdf, p. 3 (score 0.411)`
   puis l'extrait. Zéro passage : une phrase, **pas** une erreur.
4. Le résultat porte les deux formes : `content` et `structuredContent`.

Avec chloe, q06 donne `reglement-interieur.pdf` p. 3 (0.411), p. 1–2 (0.410), p. 2–3 (0.401),
p. 4–5 (0.393), p. 2 (0.384) : **exactement** ce que renvoie `npm run search -- --user chloe` pour
la même question. Même `retrieve`, même base, mêmes droits. Avec bruno et `k: 10` : 7 passages,
tous de `discordinvites.pdf`.

**Pourquoi** :
- **Deux formes du même résultat** : `content` est ce que la plupart des clients donnent au modèle ;
  `structuredContent` sert un programme qui veut les champs. Quand un `outputSchema` est déclaré,
  le SDK exige `structuredContent` et le valide (`validateToolOutput`) ; il saute cette validation
  pour un résultat `isError`, qui n'a pas de `structuredContent`.
- **« Aucun passage » n'est pas une erreur** : pour bruno, une question RH ne trouve rien qu'il ait
  le droit de lire. C'est une réponse normale, que le modèle doit relayer (« les documents ne le
  disent pas »), pas une panne à réessayer.
- **`passages[i]!.score`** : le score déjà arrondi, pour que texte et données affichent le même
  nombre. Le `!` est imposé par `noUncheckedIndexedAccess` ; `passages` et `chunks` ont la même longueur.

## `apps/mcp-server/src/tools/list-documents.ts`

```ts
      // Aucun argument : inputSchema omis.
      outputSchema: { documents: z.array(documentSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool("list_documents", "Impossible de lister les documents (base indisponible). Réessaie plus tard.", async () => {
        // Le filtre par groupes est dans la requête SQL : les documents
        // interdits ne quittent jamais la base.
        const rows = await listVisibleDocuments(pool, user.groupes);
        const documents = rows.map((doc) => ({
          fichier: doc.fileName,
          pages: doc.pages,
          ingere_le: doc.ingestedAt.toISOString(),
        }));
```

**Ce que fait le code** : pas d'`inputSchema`, donc un outil sans argument. Le handler appelle
`listVisibleDocuments` avec les groupes du contexte, convertit la date en ISO 8601, et renvoie une
ligne par document (`- discordinvites.pdf : 4 page(s), ingéré le …`) plus le `structuredContent`.

**Pourquoi** :
- **Un outil, pas une resource** (leçon 5) : une resource est lue à l'initiative de l'application
  (l'utilisateur la joint) ; ici, c'est le modèle qui décide de vérifier ce qui existe, avant de dire
  qu'une information manque. La description le lui suggère.
- **Aucun contenu** : la liste dit ce qui existe, `search_documents` dit ce que ça contient. Deux
  outils aux rôles nets, que la description sépare (« Ne l'utilise pas pour répondre à une question
  sur le contenu »).
- **Pas d'appel à Voyage** : seulement Postgres. C'est l'outil à essayer en premier quand on teste.

## `.mcp.json`

```json
    "chatbot-rag": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "env": {
        "MCP_USER_ID": "chloe"
      }
    }
```

**Ce que fait le code** : déclare un serveur MCP pour Claude Code dans ce projet. Claude Code lance
`npm run --silent mcp` à la racine du dépôt, avec `MCP_USER_ID=chloe` dans l'environnement, et
parle au processus par stdin/stdout. L'Inspector lit le même fichier avec `--config .mcp.json`.

**Pourquoi** (leçon 9) :
- **La commande npm, pas `node apps/mcp-server/dist/index.js`** : elle compile d'abord. Un clone tout
  frais fonctionne sans build manuel, et le serveur tourne toujours sur le code courant.
- **`--silent`** : voir plus haut, le bandeau de npm sur stdout.
- **L'identité dans `env`** : c'est le lanceur qui la fixe. Le fichier est versionné ; changer
  d'utilisateur, c'est modifier `env` et relancer le serveur, pas demander au modèle.
- **Aucun secret** : la clé Voyage reste dans `apps/api/.env`, ignoré par git.

## Pour explorer toi-même

Postgres doit tourner (`npm run db:up`) : le serveur le vérifie au démarrage. Voyage est limité
à 3 requêtes par minute sur ce compte : seuls les appels marqués **(Voyage)** le consomment.

- **Les refus de démarrage**, sans Voyage :
  `npm run --silent mcp; echo "exit $?"` puis `MCP_USER_ID=zoe npm run --silent mcp; echo "exit $?"`.
  À voir : les messages de `requireUser` sur stderr, `exit 1`. Ajoute `>/tmp/out.txt` et vérifie que
  le fichier est vide (`wc -c /tmp/out.txt` : 0).
- **Une poignée de main à la main**, sans Voyage (envoie `initialize`, puis stdin se ferme et
  `shutdown` s'exécute) :

  ```sh
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
    | MCP_USER_ID=chloe npm run --silent mcp
  ```

  À voir : une ligne JSON (`serverInfo` `chatbot-rag`), et `[mcp] prêt (utilisateur chloe, recherche vector)`.
  Ajoute `2>/dev/null` : il ne reste que le JSON, c'est tout ce que voit un client.
- **La pollution de stdout** : la même commande avec `npm run mcp` (sans `--silent`) et
  `2>/dev/null`. Le bandeau `> chatbot@0.1.0 mcp` arrive avant le JSON : un client échouerait sur
  cette ligne.
- **Le filet `redirectConsoleToStderr`** : ajoute `console.log("coucou");` après le `log("prêt…")`
  de `index.ts`, relance la poignée de main avec `2>/dev/null` : `coucou` n'apparaît pas (il est
  parti sur stderr). Commente ensuite `redirectConsoleToStderr();` : `coucou` arrive sur stdout,
  à côté du JSON. Remets tout.
- **Une base injoignable** : `DATABASE_URL=postgres://rag:rag@localhost:5499/rag MCP_USER_ID=chloe npm run --silent mcp`
  (l'URL de `.env.example`, port changé ; `loadEnvFile` n'écrase pas une variable déjà définie). À voir : `démarrage impossible : connect ECONNREFUSED ::1:5499`, `exit 1`.
  Retire `describe` (remplace par `error.message`) pour voir le message vide de l'`AggregateError`.
- **Les outils vus par un client**, sans Voyage :
  `npx @modelcontextprotocol/inspector --cli --config .mcp.json --server chatbot-rag --method tools/list`.
  À voir : `inputSchema` avec `"maximum": 10` et `"default": 5`, `outputSchema`, `annotations`.
- **Les droits par la liste**, sans Voyage : ajoute
  `--method tools/call --tool-name list_documents` à la commande précédente (chloe : deux
  documents), puis `-e MCP_USER_ID=bruno` (seulement `discordinvites.pdf`, 4 pages). Regarde stderr :
  `list_documents : ok en … ms`.
- **La validation du SDK**, sans Voyage : `--method tools/call --tool-name search_documents --tool-arg question=congés --tool-arg k=20`.
  À voir : `isError` avec `Too big: expected number to be <=10 at k`, et **aucune** ligne
  `search_documents :` sur stderr, puisque le handler n'a pas été appelé.
- **q06 de bout en bout (Voyage, 1 requête)** :
  `--tool-name search_documents --tool-arg "question=Je bosse depuis mon salon : la boîte me file un petit quelque chose pour mes factures ?"`.
  Compare avec `npm run search -- --user chloe "Je bosse depuis mon salon : …"` **(Voyage)** : mêmes
  cinq passages, mêmes scores. Puis avec `-e MCP_USER_ID=bruno` **(Voyage)** : uniquement
  `discordinvites.pdf`. Espace ces appels d'au moins 20 secondes.
- **L'Inspector web** : `npx @modelcontextprotocol/inspector -e MCP_USER_ID=chloe npm run --silent mcp`.
  `list_documents` d'abord ; `search_documents` **(Voyage)** affiche le texte et le `structuredContent`.
  Avec `--config .mcp.json`, l'interface web liste tous les serveurs du fichier (`--server` n'y est
  pas pris en compte).
- **Une erreur d'outil**, **(Voyage, 1 requête rejetée)** : mets une fausse `EMBEDDING_API_KEY` dans
  `apps/api/.env`, appelle `search_documents` dans l'Inspector web. Le modèle reçoit le message
  public ; le terminal montre le HTTP 401 ; `list_documents` marche encore. Remets la clé.
- **Les références TypeScript** : `npx tsc -b apps/mcp-server --verbose`. À voir : `Projects in this
  build` avec `packages/rag` puis `apps/mcp-server`, et `is up to date`. Modifie un commentaire de
  `packages/rag/src/retrieve.ts` et relance : les deux projets sont reconstruits, dans l'ordre.
- **Les conditions d'export**, depuis `apps/mcp-server` :
  `node --input-type=module -e 'console.log(import.meta.resolve("@chatbot/rag/env"))'` donne
  `…/packages/rag/dist/env.js` ; avec `node --conditions=development …`, `…/packages/rag/src/env.ts`.
  C'est toute la différence entre le serveur MCP (`node`) et l'API (`tsx --conditions=development`).
