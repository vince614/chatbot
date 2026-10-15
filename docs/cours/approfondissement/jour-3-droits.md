# Approfondissement · Jour 3 · Cours 2 — Le code des droits d'accès

> [← Retour au cours](../jour-3-droits.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/src/rag/db/migrations/003_acl.sql` | colonne `allowed_groups text[]`, refus par défaut, index GIN | 1, 3 |
| `apps/api/src/rag/acl.ts` | `ACL_FILE`, `groupSchema`, `loadAcl` : lit et valide `acl.json` | 2, 10 |
| `apps/api/data/pdfs/acl.example.json`, `.gitignore` | le modèle d'ACL versionné, le vrai `acl.json` ignoré | 2 |
| `apps/api/src/rag/db/repository.ts` | droits à l'insertion, `applyAcl`, le filtre `&&` des deux requêtes | 2, 3, 4, 5 |
| `apps/api/src/rag/scripts/ingest.ts` | ACL lue en premier, `warnAboutAcl`, `applyAcl` après la boucle | 2, 10 |
| `apps/api/src/rag/retrieve.ts` | `userGroups` obligatoire, `[]` sans Voyage, deux branches filtrées | 0, 4, 5, 6 |
| `apps/api/src/auth/users.ts`, `apps/api/data/users.json` | l'annuaire fictif : `loadUsers`, `requireUser` | 7, 9 |
| `apps/api/src/auth/fake-identity.ts` | `identifyUser` : l'en-tête `X-User-Id` (exercice seulement) | 7 |
| `apps/api/src/routes/chat.ts` | étape 0 (401), groupes passés à `retrieve`, `userId` dans les logs | 6, 7 |
| `apps/api/src/server.ts` | `loadUsers` au démarrage, `GET /api/users` | 7 |
| `apps/api/src/rag/scripts/search.ts`, `ask.ts` | `--user`, `$3` dans `--sql` et `--explain` | 4, 5 |
| `apps/api/src/evals/run.ts`, `types.ts`, `report.ts`, `compare.ts` | `eval:run -- --user`, `utilisateur` dans le run | 9 |
| `apps/web/src/chat/api.ts` | `ChatUser`, `fetchUsers`, en-tête `X-User-Id`, message du 401 | 7, 8 |
| `apps/web/src/chat/useChat.ts` | `useChat(userId)`, `updateAssistant`, `reset` | 8 |
| `apps/web/src/chat/UserSelect.tsx`, `Chat.tsx`, `Composer.tsx` | sélecteur, changement d'utilisateur, envoi verrouillé | 8 |

## Le parcours dans le code

Bruno (groupe `tech`) est choisi dans le sélecteur et demande « Combien de jours de congé paternité
chez Lumen ? ». `RAG_SEARCH_MODE=hybrid`.

1. **`Chat.tsx`** : `userId` vaut `"bruno"`, passé à `useChat(userId)`. Pas de `lockedHint` :
   l'envoi est permis.
2. **`useChat.ts` → `send` → `run`** : `streamChat(wire, userId, controller.signal, { … })`.
3. **`api.ts` → `streamChat`** : `POST /api/chat` avec l'en-tête `X-User-Id: bruno`.
4. **`chat.ts`, étape 0** : `identifyUser(request, users)` trouve bruno dans la `Map` chargée au
   démarrage par `server.ts`. Sans lui : 401, et rien d'autre ne se passe.
5. **`searchDocuments(retrieve, question, user, …)`** appelle `retrieve` avec
   `userGroups: user.groupes`, soit `["tech"]`.
6. **`retrieve.ts`** : vérifications, tableau non vide, puis `case "hybrid"` : `searchVector`
   (Voyage puis `searchChunks`) et `searchLexical`, **toutes deux** avec `userGroups`.
7. **`repository.ts`** : `$3 = {tech}` ; `WHERE d.allowed_groups && $3::text[]` écarte
   `reglement-interieur.pdf` (`{rh}`) **avant** le tri et le `LIMIT`.
8. **`fuseByRrf`**, puis la suite inchangée : `sources`, `buildRagPrompt`, le modèle. Il n'a reçu
   aucun passage du règlement : il dit qu'il ne trouve pas l'information.
9. **Le log** de `searchDocuments` contient `userId: "bruno"`, jamais la question ni les groupes.

En amont, une fois : `npm run ingest` a lu `acl.json`, écrit les droits avec chaque document
réingéré (`replaceDocument`), puis appliqué l'ACL à tous les documents (`applyAcl`).

## `apps/api/src/rag/db/migrations/003_acl.sql`

```sql
-- DEFAULT '{}' (tableau vide) : refus par défaut. Les documents déjà en base
-- deviennent invisibles jusqu'à ce que « npm run ingest » applique l'ACL, et
-- un document inséré sans droits n'est visible par personne.
ALTER TABLE documents
    ADD COLUMN allowed_groups text[] NOT NULL DEFAULT '{}';

-- Index GIN : il accélère l'opérateur de recouvrement && (« au moins un
-- groupe en commun ») utilisé par le filtre de la recherche.
CREATE INDEX documents_allowed_groups_idx ON documents USING gin (allowed_groups);
```

**Ce que fait le code**, dans l'ordre du code :
1. `allowed_groups text[]` : un **tableau** de textes Postgres. Littéraux : `'{rh}'`,
   `'{rh,tech}'`, `'{}'`.
2. `NOT NULL DEFAULT '{}'` : l'`ALTER TABLE` remplit les lignes existantes avec le tableau vide,
   comme le ferait un `INSERT` qui ne donne pas la colonne.
3. `USING gin` : un index inversé sur les **éléments** du tableau (pour chaque groupe, les
   documents qui le portent), comme `content_tsv` l'était sur les lexèmes.

**Pourquoi c'est écrit ainsi** :
- **Sur `documents`, pas sur `chunks`** (leçon 3). Tous les chunks d'un document ont les mêmes
  droits ; les recopier sur chaque chunk, c'est risquer qu'un chunk garde d'anciens droits. La
  recherche joint déjà `documents` pour le nom du fichier : le filtre réutilise cette jointure.
- **`'{}'` et non `NULL`** : `NULL && $3` vaut `NULL`, que le `WHERE` traite comme faux. Même
  résultat, mais par accident. `NOT NULL` impose une seule façon de dire « personne ».
- **Refus par défaut** : juste après la migration, la recherche ne trouve plus rien pour personne.
  Un document invisible par oubli se voit tout de suite ; un document public par oubli est une fuite.

## `apps/api/src/rag/acl.ts`

### `ACL_FILE`, `groupSchema`, `aclSchema`

```ts
export const ACL_FILE = `${PDF_DIR}acl.json`;

/** Un nom de groupe : lettres, chiffres, « - » et « _ » (pas d'espace parasite, pas de casse ambiguë). */
export const groupSchema = z.string().regex(/^[a-z0-9_-]+$/, "groupe invalide (attendu : minuscules, chiffres, - ou _)");

const aclSchema = z.record(z.string().min(1), z.array(groupSchema));
```

**Ce que fait le code** : `PDF_DIR` est le chemin absolu de `apps/api/data/pdfs/` (barre finale
comprise) ; l'ACL vit à côté des PDF. `groupSchema` n'accepte que minuscules, chiffres, `_` et
`-`, sur **toute** la chaîne (`^…$`) ; il est **exporté** pour `users.ts`. `aclSchema` : un objet
nom de fichier → tableau de groupes.

**Pourquoi** : `&&` compare des chaînes **exactement**. `"RH"`, `"rh "` et `"rh"` sont trois
groupes différents ; un utilisateur `rh` ne verrait pas un document marqué `"RH"`. Le même schéma
pour l'ACL et pour les utilisateurs garantit que les deux côtés s'écrivent pareil. Une liste vide
est acceptée : « personne » est un choix légitime.

### `loadAcl()`

```ts
export async function loadAcl(file = ACL_FILE): Promise<Acl> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`ACL introuvable : ${file}. Copie acl.example.json en acl.json et renseigne les groupes.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`ACL invalide (${file}) : JSON mal formé (${error instanceof Error ? error.message : error}).`);
  }

  const parsed = aclSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`ACL invalide (${file}) : ${z.prettifyError(parsed.error)}`);
  }

  // Triés et dédoublonnés : deux listes égales s'écrivent pareil, et la base
  // ne voit un changement que s'il y en a vraiment un.
  return new Map(Object.entries(parsed.data).map(([fileName, groups]) => [fileName, [...new Set(groups)].sort()]));
}
```

**Ce que fait le code**, dans l'ordre du code :
1. **Fichier absent** → première `ConfigError`, avec la marche à suivre.
2. **JSON mal formé** (virgule en trop) → deuxième, qui recopie le message de `JSON.parse`.
3. **Mauvaise forme** (`"rh"` au lieu de `["rh"]`, un groupe `"RH"`) → troisième, où
   `z.prettifyError` nomme la clé en faute.
4. **Normalisation** : pour chaque paire `[fichier, groupes]`, `new Set` retire les doublons,
   `[...…]` refait un tableau, `.sort()` le trie. Le tout devient une `Map` (le type `Acl`).

**Pourquoi c'est écrit ainsi** :
- **Échouer plutôt que deviner** (leçon 10). Une ACL absente lue comme `{}` ferait passer tous les
  documents à `'{}'` au prochain `applyAcl` : chatbot muet pour tous, à cause d'un fichier mal
  nommé. L'erreur arrive **avant** toute écriture, la base reste telle qu'elle était.
- **Une seule classe** : `ingest.ts` affiche une `ConfigError` sans pile d'appels. Ce sont des
  fautes de configuration, pas des bugs.
- **Trier** : pour Postgres, `{rh,tech}` et `{tech,rh}` sont **différents**. Sans le tri,
  réordonner une liste dans `acl.json` réécrirait le document à chaque ingestion.

### `acl.example.json` et `.gitignore`

```json
{
  "reglement-interieur.pdf": ["rh"],
  "discordinvites.pdf": ["tech"]
}
```

Et dans `.gitignore` :

```gitignore
# PDF du RAG et leurs droits (acl.json) : déposés à la main, jamais versionnés
apps/api/data/pdfs/*
!apps/api/data/pdfs/.gitkeep
!apps/api/data/pdfs/acl.example.json
```

`apps/api/data/pdfs/*` ignore tout le dossier, `acl.json` compris ; les `!` font deux exceptions.
L'ACL réelle décrit des documents réels (leurs noms, qui y a accès) : elle reste locale, comme les
PDF. L'exemple est versionné : c'est le modèle que cite la première `ConfigError`.

## `apps/api/src/rag/db/repository.ts`

### `replaceDocument()` : les droits dans la transaction

```ts
    // Les droits sont écrits dans la même transaction que les chunks : la
    // nouvelle version n'existe jamais sans ses droits.
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO documents (file_name, sha256, allowed_groups) VALUES ($1, $2, $3) RETURNING id",
      [doc.fileName, doc.sha256, doc.allowedGroups],
    );
```

**Ce que fait le code** : la transaction du jour 2 (`DELETE`, `INSERT` du document, `INSERT` des
chunks, `COMMIT`) ; seul l'`INSERT` du document gagne une colonne. `$3` est un tableau
JavaScript, que `pg` envoie comme un littéral `{…}`. Dans `DocumentToStore`, le champ
`allowedGroups: string[]` est **obligatoire**.

**Pourquoi** : le `DELETE` efface l'ancien document **et ses droits**. Écrits plus tard, la
nouvelle version existerait un instant avec `'{}'`. Ici, le `COMMIT` publie d'un coup le contenu et
ses droits, et le compilateur refuse un appel qui les oublie.

### `applyAcl()`

```ts
export async function applyAcl(
  pool: pg.Pool,
  acl: Map<string, string[]>,
): Promise<{ fileName: string; allowedGroups: string[] }[]> {
  const { rows } = await pool.query<{ file_name: string; allowed_groups: string[] }>(
    `WITH target AS (
       SELECT id, ARRAY(SELECT jsonb_array_elements_text($1::jsonb -> file_name)) AS groups
       FROM documents
     )
     UPDATE documents d
     SET allowed_groups = t.groups
     FROM target t
     WHERE d.id = t.id AND d.allowed_groups IS DISTINCT FROM t.groups
     RETURNING d.file_name, d.allowed_groups`,
    [JSON.stringify(Object.fromEntries(acl))],
  );
  return rows.map((row) => ({ fileName: row.file_name, allowedGroups: row.allowed_groups }));
}
```

**Ce que fait le code**, dans l'ordre du code :
1. **Le paramètre** : `Object.fromEntries(acl)` refait un objet à partir de la `Map`,
   `JSON.stringify` en fait une chaîne. **Toute** l'ACL part en un seul `$1`.
2. **Le CTE `target`** donne, pour **chaque** document de la table, les groupes de l'ACL :
   - `$1::jsonb` relit la chaîne comme un objet JSON ;
   - `-> file_name` y prend la valeur de la clé du document : un tableau JSON (`["rh"]`), ou
     `NULL` si la clé n'existe pas ;
   - `jsonb_array_elements_text(…)` fait de ce tableau des **lignes** de texte ; sur `NULL`, elle
     n'en produit **aucune** ;
   - `ARRAY(SELECT …)` regroupe ces lignes en `text[]` : `{rh}`, ou `{}` s'il n'y en a aucune.
3. **`UPDATE … FROM target t WHERE d.id = t.id`** associe chaque document à sa ligne du CTE ;
   **`IS DISTINCT FROM`** ne garde que ceux dont les droits **changent**.
4. **`RETURNING`** renvoie le nom et les nouveaux droits des seules lignes réécrites.

**Exemple déroulé** : la base contient `discordinvites.pdf {tech}` et
`reglement-interieur.pdf {rh}`. On réduit `acl.json` à `{"reglement-interieur.pdf":["rh"]}`, puis
`npm run ingest` (les deux PDF sont inchangés, aucun n'est réingéré).

| Document | `$1::jsonb -> file_name` | `t.groups` | `d.allowed_groups` | `IS DISTINCT FROM` | Réécrit ? |
| --- | --- | --- | --- | --- | --- |
| `discordinvites.pdf` | `NULL` (clé absente) | `{}` | `{tech}` | vrai | oui → `{}` |
| `reglement-interieur.pdf` | `["rh"]` | `{rh}` | `{rh}` | faux | non |

`RETURNING` renvoie une seule ligne. Sortie observée (après l'avertissement de `warnAboutAcl`) :

```text
🔒 discordinvites.pdf : droits → personne
Droits : 1 document(s) mis à jour, les autres étaient déjà à jour.
```

**Pourquoi c'est écrit ainsi** :
- **Tous les documents, à chaque ingestion.** L'ingestion saute un PDF au `sha256` inchangé ; or
  modifier `acl.json` ne change pas le `sha256` des PDF. Sans `applyAcl`, retirer un groupe
  n'aurait **aucun effet** sur un document déjà ingéré : la panne qui ne se voit pas.
- **La requête part de `documents`, pas de l'ACL** : un document que l'ACL ne cite pas reçoit
  `{}`. Le refus par défaut s'applique aussi aux oubliés.
- **Une seule instruction**, donc atomique : jamais la moitié des documents aux nouveaux droits.
- **`Object.fromEntries` est indispensable** : `JSON.stringify(new Map(…))` donne `"{}"` (une
  `Map` n'a pas de propriétés énumérables). Envoyer la `Map` telle quelle retirerait les droits de
  tous les documents.
- **`IS DISTINCT FROM` plutôt que `<>`** : identiques ici (ni la colonne ni `ARRAY(…)` ne valent
  `NULL`), mais `IS DISTINCT FROM` reste juste face à un `NULL`, là où `<>` donnerait `NULL`.
  Ne réécrire que ce qui change permet d'afficher exactement ce qui a bougé.

### Le filtre dans `SEARCH_SQL` et `LEXICAL_SEARCH_SQL`

Dans `SEARCH_SQL` (vectoriel) :

```ts
JOIN documents d ON d.id = c.document_id
WHERE d.allowed_groups && $3::text[]
ORDER BY c.embedding <=> $1::vector
LIMIT $2`;
```

Dans `LEXICAL_SEARCH_SQL` (plein texte) :

```ts
WHERE c.content_tsv @@ q.query
  AND d.allowed_groups && $3::text[]
ORDER BY score DESC, c.id
LIMIT $2`;
```

**Ce que fait le code** : `$3::text[]` reçoit les groupes de l'utilisateur. `&&` est l'opérateur
de **recouvrement** : vrai si les deux tableaux ont **au moins un élément en commun**. Dans le
`WHERE`, il retire les chunks interdits **avant** `ORDER BY` et `LIMIT`. Les fonctions
`searchChunks` et `searchLexical` gagnent un quatrième paramètre, `userGroups: readonly string[]`,
**sans valeur par défaut**, qui devient `$3` :

```ts
  const { rows } = await pool.query<SearchRow>(LEXICAL_SEARCH_SQL, [question, limit, userGroups]);
```

**Exemple déroulé : `&&` pour bruno** (`$3 = {tech}`) :

| `d.allowed_groups` | Document | Test | Chunk gardé ? |
| --- | --- | --- | --- |
| `{rh}` | `reglement-interieur.pdf` | `{tech} && {rh}` = false | non |
| `{tech}` | `discordinvites.pdf` | `{tech} && {tech}` = true | oui |
| `{}` | un document sans droits | `{} && {tech}` = false | non |

Pour chloé (`{rh,tech}`), les deux premiers sont vrais. Le tableau vide ne recouvre jamais rien :
`'{}'` est un refus, côté document comme côté utilisateur.

**Exemple déroulé : avant ou après le classement** (leçon 4). Bruno demande « Combien de jours de
congé paternité chez Lumen ? ». La réponse est dans le règlement, qu'il ne peut pas lire. Observé,
en `k = 5` :

| Variante | Les 5 passages renvoyés |
| --- | --- |
| Sans filtre (vectoriel) | `reglement-interieur.pdf` #2, #1, #0, #5, #3 |
| Filtre **après** le `LIMIT` (en TypeScript) | aucun : les 5 étaient interdits |
| Filtre **avant**, dans le `WHERE` | 5 chunks de `discordinvites.pdf` |
| Hybride, branche plein texte **non filtrée** | `discordinv#2 discordinv#6 reglement-#2 discordinv#1 reglement-#1` |
| Hybride, **deux branches filtrées** | uniquement `discordinvites.pdf` |

- **Filtrer après** est sûr mais vide : les autorisés, 6e et au-delà, ont été coupés par le
  `LIMIT`. Et un « 0 résultat » qui dépend de documents interdits trahit déjà qu'ils existent.
- **Filtrer avant** : le `LIMIT` porte sur les seuls chunks autorisés. Aucun ne parle de congé
  paternité ; le modèle le dira.
- **L'hybride à moitié filtré fuit** (leçon 5) : la branche plein texte non filtrée trouve
  « congé », « paternité », « Lumen » dans le règlement, et `fuseByRrf` additionne sans regarder
  les droits : `reglement-#2` et `reglement-#1` sortent 3e et 5e.

**Pourquoi pas de valeur par défaut** : `userGroups = []` compilerait partout et rendrait des
résultats vides en silence. Et les groupes passent en **paramètre lié**, jamais concaténés au
SQL : venus un jour d'un jeton, ils ne pourront pas changer la requête.

## `apps/api/src/rag/scripts/ingest.ts`

```ts
    // L'ACL est lue en premier : invalide, rien n'est ingéré ni modifié.
    const acl = await loadAcl();
    const files = await listPdfs(PDF_DIR);
    warnAboutAcl(acl, files);
    const known = await getDocumentHashes(pool);
```

Puis, dans la boucle, chaque fichier reçoit ses groupes via `IngestDeps` (nouveau champ
`allowedGroups: string[]`), que `ingestFile` transmet à `replaceDocument` :

```ts
        allowedGroups: acl.get(fileName) ?? [],
```

Et après la boucle :

```ts
    // Les droits de tous les documents en base, inchangés compris.
    const changed = await applyAcl(pool, acl);
    for (const { fileName, allowedGroups } of changed) {
      console.log(`🔒 ${fileName} : droits → ${allowedGroups.length > 0 ? allowedGroups.join(", ") : "personne"}`);
    }
    console.log(`Droits : ${changed.length} document(s) mis à jour, les autres étaient déjà à jour.`);
```

**Ce que fait le code**, dans l'ordre du code :
1. **`loadAcl()` d'abord**, juste après la vérification de la dimension. Une `ConfigError`
   remonte jusqu'au `main().catch(…)` final qui l'affiche ; aucun PDF lu, aucun appel Voyage, aucune
   écriture. Le `finally` ferme le pool.
2. **`acl.get(fileName) ?? []`** : la règle d'`applyAcl` côté TypeScript, absent = personne.
3. **`applyAcl`** passe sur **toute** la table : documents ignorés (`= inchangé`), réingérés, et
   ceux présents en base mais plus dans le dossier. Un document réingéré a déjà ses droits
   (`replaceDocument`) : `IS DISTINCT FROM` l'écarte, il n'est pas dans `changed`.
4. Une ligne `🔒` par document modifié, `personne` pour un tableau vide, puis le total.

**Pourquoi c'est écrit ainsi** : une ACL invalide découverte **après** la boucle laisserait des
documents réingérés avec des droits tirés d'un fichier faux, et aurait coûté des appels Voyage.
`applyAcl` en dernier, c'est le dernier mot : quel que soit le chemin de chaque fichier (nouveau,
inchangé, en échec, disparu), la base finit alignée sur `acl.json`.

### `warnAboutAcl()`

```ts
function warnAboutAcl(acl: Acl, files: string[]): void {
  for (const file of files) {
    const groups = acl.get(file);
    if (!groups || groups.length === 0) console.warn(`⚠ ${file} : aucun groupe dans ${ACL_FILE}, visible par personne.`);
  }
  for (const name of acl.keys()) {
    if (!files.includes(name)) console.warn(`⚠ acl.json cite « ${name} », absent de data/pdfs/ (faute de frappe ?).`);
  }
}
```

**Ce que fait le code** : deux boucles, deux incohérences. Un PDF sans groupe (absent de l'ACL ou
liste vide), puis une clé de l'ACL sans PDF.

**Pourquoi un avertissement et pas une erreur** (leçon 10) : un PDF sans groupe est un état
**sûr**, parfois voulu (déposé avant de décider qui le lira). Mais le cas typique est une faute de
frappe : `reglement-interieur.pdf` dans le dossier, `reglement_interieur.pdf` dans l'ACL. Les deux
messages apparaissent alors ensemble, et le second pointe la cause.

## `apps/api/src/rag/retrieve.ts`

Le point de contrôle : tout ce qui cherche dans les documents passe par la fonction que renvoie
`createRetriever`. Son commentaire d'en-tête le dit : « Ce qui sort de retrieve est autorisé ;
le prompt et le modèle ne voient jamais rien d'autre. » C'est la leçon 6 : le modèle n'est **pas** un maillon du contrôle d'accès. On ne lui demande pas
de « ne pas citer » un passage interdit ; il ne le reçoit jamais. Un prompt se contourne, un
`WHERE` non.

### `RetrieveOptions` et `Retrieve`

Dans `RetrieveOptions`, `userGroups` est le seul champ **sans** `?` :

```ts
  userGroups: readonly string[];
```

```ts
// options n'est pas optionnel : il porte userGroups.
export type Retrieve = (question: string, options: RetrieveOptions) => Promise<RetrievedChunk[]>;
```

**Ce que fait le code** : le paramètre s'appelait `options?` ; il est devenu `options`, et la
fonction renvoyée ne se déstructure plus avec `= {}`.

**Pourquoi** : avec `options?`, `retrieve(question)` compilerait encore, `userGroups` vaudrait
`undefined`. Ici, chaque oubli est trouvé par le compilateur, pas par un utilisateur. Retire
`userGroups` d'un appel qui ne passe que `k` (dans `ask.ts`, par exemple), puis
`npm run typecheck` :

```text
error TS2345: Argument of type '{ k: number; }' is not assignable to parameter of type 'RetrieveOptions'.
  Property 'userGroups' is missing in type '{ k: number; }' but required in type 'RetrieveOptions'.
```

`readonly string[]` : `retrieve` promet de ne pas modifier le tableau, et accepte aussi bien un
`string[]` qu'un tableau figé.

### La fonction renvoyée par `createRetriever()`

```ts
  return async (question, { userGroups, k = DEFAULT_K, mode = defaultMode, signal }) => {
    const text = question.trim();
    if (text === "") throw new Error("La question est vide.");
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new Error(`k doit être un entier entre 1 et ${MAX_K} (reçu : ${k}).`);
    }
    // Le typage protège le code TypeScript ; ceci protège un appel venu
    // d'ailleurs (JSON, JavaScript) qui passerait autre chose qu'un tableau.
    if (!Array.isArray(userGroups)) throw new Error("userGroups doit être un tableau de groupes.");
    // Aucun groupe : aucun document visible. Inutile d'appeler Voyage.
    if (userGroups.length === 0) return [];
```

Et dans le `case "hybrid"` :

```ts
        const [vector, lexical] = await Promise.all([
          searchVector(text, candidates, userGroups, signal),
          searchLexical(pool, text, candidates, userGroups),
        ]);
```

**Ce que fait le code**, dans l'ordre du code :
1. La déstructuration sort `userGroups` **sans** valeur par défaut ; puis les vérifications du
   jour 2 (question vide, `k`).
2. **`Array.isArray`** : autre chose qu'un tableau → une erreur.
3. **`length === 0`** : retour immédiat de `[]`, **avant** le `switch`, donc avant l'appel Voyage.
4. **Les trois modes** passent `userGroups` : `searchVector` (fonction interne) le transmet à
   `searchChunks`, `searchLexical` le reçoit directement. `fuseByRrf` n'a pas changé.

**Pourquoi c'est écrit ainsi** :
- **`Array.isArray` alors que le type l'interdit ?** Les types disparaissent à l'exécution. Une
  valeur venue d'un `JSON.parse` peut être `undefined` (envoyée comme `NULL` : aucun résultat, par
  accident) ou la chaîne `"tech"` (littéral de tableau invalide : erreur SQL obscure). Mieux vaut
  un message clair au bon endroit.
- **`[]` court-circuité** : le SQL donnerait le même résultat vide, mais après un appel Voyage
  payant et limité (3 requêtes/min sur ce compte).
- **Le filtre dans chaque branche, pas après la fusion** : une branche non filtrée suffit à faire
  entrer `reglement-#2` et `reglement-#1` chez bruno (tableau plus haut). Filtrer après la fusion
  boucherait la fuite, mais retrouverait le défaut du « filtre après » : des autorisés coupés par
  les `LIMIT 20`. `fuseByRrf` reste une fonction pure sur des rangs, qui n'a pas à savoir qui
  demande.

## `apps/api/src/auth/users.ts` et `apps/api/data/users.json`

`data/users.json`, **versionné** (ce sont des personnes fictives), déclare trois utilisateurs :
`alice` (`["rh"]`), `bruno` (`["tech"]`) et `chloe` (`["rh", "tech"]`), chacun avec un `nom`
affichable (`"Bruno (Tech)"`).

```ts
export const USERS_FILE = fileURLToPath(new URL("../../data/users.json", import.meta.url));

const userSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "identifiant invalide (minuscules, chiffres, - ou _)"),
  nom: z.string().min(1),
  groupes: z.array(groupSchema),
});
export type User = z.infer<typeof userSchema>;

const usersSchema = z.array(userSchema).refine((users) => new Set(users.map((u) => u.id)).size === users.length, {
  message: "identifiant en double",
});
```

**Ce que fait le code** :
1. `new URL("../../data/users.json", import.meta.url)` résout le chemin **depuis ce fichier**,
   `fileURLToPath` en fait un chemin disque : peu importe le dossier d'où l'on lance la commande.
2. `groupes` est validé par `groupSchema`, **le même** que l'ACL ; `User` est **déduit** du schéma
   (`z.infer`) : type et validation ne peuvent pas diverger.
3. `.refine` : si le `Set` des identifiants est plus petit que le tableau, il y a un doublon.

**Pourquoi le `refine`** : `loadUsers` construit une `Map` par identifiant ; en double, le second
écraserait le premier **sans bruit**, et « alice » aurait les groupes d'un autre.

**`loadUsers()` et `requireUser()`** : `loadUsers` lit et parse le fichier dans un même `try`
(« Utilisateurs illisibles »), valide (« Utilisateurs invalides »), puis renvoie une `Map`
`id → User`. `requireUser(id)`, pour les scripts, distingue `--user` absent
(`--user est obligatoire (alice, bruno, chloe).`) et inconnu (`Utilisateur inconnu : « zoe » …`),
et **liste** les identifiants connus.

**Pourquoi lister** : un script est lancé par un développeur sur sa machine ; lui donner les noms
l'aide. L'API, elle, ne les donne pas (voir `fake-identity.ts`) : la même information n'a pas la
même sensibilité selon qui la reçoit.

## `apps/api/src/auth/fake-identity.ts`

Le commentaire d'en-tête prévient : **exercice uniquement**. N'importe qui peut envoyer
`X-User-Id: chloe` avec `curl` et obtenir ses droits. En production : une preuve vérifiée par le
serveur (cookie de session, JWT signé), et des groupes tirés de cette preuve, jamais du client.

```ts
export function identifyUser(request: FastifyRequest, users: ReadonlyMap<string, User>): User | null {
  const raw = request.headers[USER_ID_HEADER];
  // Un en-tête répété arrive sous forme de tableau : ambigu, donc refusé.
  if (typeof raw !== "string") return null;
  return users.get(raw.trim()) ?? null;
}
```

**Ce que fait le code** :
1. `USER_ID_HEADER` vaut `"x-user-id"`, en **minuscules** : Node normalise les en-têtes reçus.
2. `request.headers[…]` est de type `string | string[] | undefined` : absent ou tableau → `null`.
3. `raw.trim()`, puis `users.get` ; inconnu → `undefined`, ramené à `null` par `?? null`.

**Pourquoi c'est écrit ainsi** :
- **Le tableau refusé** : deux `X-User-Id` dans une requête (un ajouté par un proxy, un par le
  client), lequel croire ? Choisir, c'est laisser l'attaquant deviner lequel gagne.
- **`null` pour absent comme pour inconnu** : la réponse est la même, un attaquant qui essaie des
  noms n'apprend pas lesquels existent.
- **Le reste du code ne voit que `User`** : remplacer ce fichier par une vraie authentification ne
  touchera ni la route ni la recherche.

## `apps/api/src/routes/chat.ts`

```ts
    // 0. Qui demande ? Avant tout le reste : sans identité, ni validation du
    //    corps, ni recherche, ni appel au modèle. (Remplaçant d'authentification :
    //    voir auth/fake-identity.ts.)
    const user = identifyUser(request, users);
    if (!user) {
      // Ni l'en-tête reçu ni la raison exacte dans la réponse : absent et
      // inconnu sont indiscernables pour le client.
      request.log.warn("requête sans utilisateur identifié");
      return reply.code(401).send({ error: "Utilisateur non identifié." });
    }
```

Puis, dans `searchDocuments` (qui reçoit maintenant `user: User`) :

```ts
    const chunks = await retrieve(question, {
      userGroups: user.groupes,
      signal: AbortSignal.any([clientSignal, AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS)]),
    });
    log.info(
      {
        userId: user.id,
```

**Ce que fait le code** :
1. **Étape 0**, première instruction du handler : sans utilisateur, un avertissement dans les
   logs et une réponse JSON `401`. Le flux SSE n'est pas ouvert.
2. `users` arrive par les options du plugin (`users: ReadonlyMap<string, User>` dans
   `ChatRoutesOptions`), comme `llm`, `tools` et `retrieve`.
3. L'appel devient `searchDocuments(retrieve, question, user, controller.signal, request.log)` :
   les groupes vont à `retrieve`, l'identifiant au log.

**Pourquoi c'est écrit ainsi** (leçon 7) :
- **Avant la validation du corps** : un client non identifié n'obtient même pas le détail d'un
  `400`, et ni Voyage ni Anthropic ne sont appelés pour lui.
- **`userId` dans le log, pas les groupes** : sans l'identifiant, un « 0 passage » ne se comprend
  pas (pas de document, ou pas de droit ?). Les groupes décrivent l'organisation ; l'identifiant
  suffit à les retrouver dans `users.json`.
- **`ReadonlyMap`** : la route lit l'annuaire sans le modifier. Le reste de la route n'a pas
  changé : ce qui sort de `retrieve` est déjà autorisé. Le `warn` ne recopie pas l'en-tête reçu.

## `apps/api/src/server.ts`

Au démarrage, `const users = await exitOnConfigError(loadUsers());`, puis dans le préfixe `/api` :

```ts
    api.get("/users", async () => ({ users: [...users.values()].map(({ id, nom }) => ({ id, nom })) }));
    await api.register(chatRoutes, { llm, tools, retrieve, users });
```

**Ce que fait le code** :
1. `loadUsers()` est **asynchrone**, à la différence de `loadConfig` : `loadConfigOrExit` ne
   convient pas. `exitOnConfigError`, en bas du fichier, attend la promesse ; sur une
   `ConfigError`, elle affiche `[config] …` et appelle `process.exit(1)`. Toute autre erreur est
   relancée.
2. `GET /api/users` réduit chaque `User` à `{ id, nom }` par déstructuration.
3. `users` est passé à `chatRoutes`.

**Pourquoi c'est écrit ainsi** :
- **Au démarrage, une fois** : un `users.json` cassé arrête le serveur tout de suite, pas à la
  première question. Le revers : modifier `users.json` demande un redémarrage.
- **Jamais les groupes** dans `/api/users` : l'interface n'en a pas besoin pour afficher un nom,
  et ils dessinent la politique d'accès. Ce qu'un client n'a pas besoin de savoir, on ne le lui
  envoie pas. En production, cette route n'existerait pas : on est celui qu'on est après connexion.

## Les scripts : `search.ts` et `ask.ts`

Dans `apps/api/src/rag/scripts/search.ts`, `user: { type: "string" }` s'ajoute à `parseArgs`,
`requireUser(values.user)` est appelé juste avant `loadDatabaseConfig()`, puis :

```ts
    const results = await retrieve(question, { userGroups: user.groupes, k: DEFAULT_K, mode });
```

**Ce que fait le code** :
1. `requireUser` vient **après** l'usage, **avant** la connexion : un `--user` oublié ou mal
   écrit ne coûte ni connexion ni appel Voyage.
2. `--sql` annonce `$3 = groupes de ${user.id}` dans l'en-tête de chaque requête.
3. Les deux `EXPLAIN ANALYZE` reçoivent `user.groupes` en troisième paramètre : une requête à `$3`
   exécutée avec deux valeurs serait refusée par Postgres.
4. Sans résultat, le message dit pour qui :
   `Aucun chunk autorisé pour ${user.id} (documents absents, ou aucun groupe en commun).`

Dans `apps/api/src/rag/scripts/ask.ts`, le même `requireUser(values.user)` avant le client
Anthropic, puis :

```ts
    const chunks = await retrieve(question, { userGroups: user.groupes, k: Number(values.k) });
```

**Pourquoi `--user` obligatoire** : chercher « sans utilisateur » obligerait à choisir. `[]` ne
montrerait rien, tous les groupes montreraient tout. Le but est l'inverse : voir **exactement** ce
que voit une personne donnée.

## L'évaluation : `run.ts`, `types.ts`, `report.ts`, `compare.ts`

Dans `apps/api/src/evals/run.ts`, `const user = await requireUser(values.user);` ouvre `main`,
la `RunConfig` gagne `utilisateur: { id: user.id, groupes: user.groupes }`, et la boucle devient :

```ts
      const result = await runQuestion(question, { retrieve, llm, userGroups: user.groupes });
```

Dans `warnIfNotComparable` (`apps/api/src/evals/compare.ts`) :

```ts
    // Un autre utilisateur voit d'autres documents : la recherche n'est plus la même.
    ["utilisateur", (run) => run.config.utilisateur ?? null],
```

**Ce que fait le code** :
1. `requireUser` est la **première** chose que fait `main` : avant le mode, la configuration et
   tout appel payant.
2. Le run enregistre l'utilisateur **et ses groupes** : si `users.json` change, le run garde ce
   qui était vrai le jour où il a été produit. `runQuestion` appelle
   `retrieve(question.question, { userGroups, k: DEFAULT_K })`.
3. Dans `types.ts`, `utilisateur?` est optionnel, comme `recherche?` : les anciens runs restent
   lisibles. `report.ts` affiche `utilisateur …`, ou `(avant les droits)` pour un ancien run.
4. `compare.ts` ajoute une colonne `utilisateur` à l'en-tête (`—` si absent) et un contrôle à
   `warnIfNotComparable` ; `?? null` ramène l'absence à une seule valeur, `"null"` une fois
   sérialisée.

**Pourquoi c'est écrit ainsi** (leçon 9) : `questions.json` couvre les deux documents. Un run
`--user bruno` ne trouvera jamais les réponses du règlement : ce n'est pas une régression, c'est le
contrôle d'accès qui marche. `--user chloe` reproduit les conditions des runs précédents. Comparer
un run de bruno et un de chloé mesurerait les droits, pas la recherche : d'où
`⚠ Les runs diffèrent aussi par : utilisateur.` L'objet entier est comparé, identifiant **et**
groupes.

## L'interface

### `apps/web/src/chat/api.ts`

```ts
/** Un utilisateur proposé par le sélecteur ; le serveur n'expose jamais ses groupes. */
export type ChatUser = { id: string; nom: string };
```

`streamChat` reçoit maintenant `userId` en deuxième paramètre et l'envoie, sous un commentaire
« REMPLAÇANT D'AUTHENTIFICATION, pour l'exercice » :

```ts
      "X-User-Id": userId,
```

**Ce que fait le code** :
1. `ChatUser` n'a pas de `groupes` : le type reflète ce que le serveur envoie.
2. `fetchUsers(signal)` appelle `GET /api/users`, lève une `ChatError` si la réponse n'est pas
   `ok`, et renvoie `body.users ?? []`.
3. L'en-tête part sur chaque `POST /api/chat`.
4. Dans `describeHttpError`, un `401` est un JSON classique, pas un flux SSE : son champ `error`
   (« Utilisateur non identifié. ») devient le message du bandeau d'erreur.

### `apps/web/src/chat/useChat.ts`

`useChat(userId)` reçoit l'identité ; `run`, `send` et `retry` ne font rien si elle est vide, et
`userId` entre dans leurs dépendances `useCallback`.

#### `updateAssistant`

```ts
    // Un flux annulé (Stop, changement d'utilisateur) ne doit plus toucher aux messages,
    // même si des événements déjà lus restent à traiter.
    const updateAssistant = (update: (message: UiMessage) => UiMessage) => {
      if (!controller.signal.aborted) setMessages((prev) => updateLastAssistant(prev, update));
    };
```

**Ce que fait le code** : les quatre handlers (`onDelta`, `onSources`, `onToolCall`,
`onToolResult`) appelaient chacun `setMessages(… updateLastAssistant …)` ; ils passent tous par
`updateAssistant`, qui ne fait rien si **ce** flux (`controller`, capturé par fermeture) est annulé.

**Pourquoi** : `abort()` n'interrompt pas une boucle JavaScript en cours. Un seul
`reader.read()` peut contenir plusieurs événements SSE, que `streamChat` distribue l'un après
l'autre ; l'annulation n'apparaît qu'au **prochain** `read()`. Sans la garde, ces deltas déjà lus
s'ajouteraient à la conversation suivante.

#### `reset()` et la garde du `catch`

```ts
  const reset = useCallback(() => {
    // Changement d'utilisateur : on repart d'une conversation vide. Sinon l'historique renvoyé
    // au modèle contiendrait des réponses tirées des documents de l'utilisateur précédent
    // (fuite par l'historique), et l'écran afficherait ses sources.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setError(null);
    setStatus("idle");
    append("action", "reset : conversation vidée (changement d'utilisateur)");
  }, [append]);
```

```ts
    } catch (err) {
      // Flux remplacé par reset() : l'état appartient déjà à la conversation suivante.
      if (abortRef.current !== controller) return;
```

**La fuite par l'historique** (leçon 8) : à chaque question, **tout** l'historique repart au
serveur. Si chloé a obtenu une réponse tirée du règlement et qu'on passe à bruno sans vider la
conversation, la question suivante de bruno emporte cette réponse : le modèle la lit et peut la
répéter. Le filtre SQL n'y peut rien, ce texte ne vient pas de `retrieve`.

**Exemple déroulé** : chloé reçoit une réponse en flux (contrôleur `C1`) ; on choisit bruno avant
la fin.

1. **`handleUserChange("bruno")`** appelle `reset()`.
2. **`abortRef.current.abort()`** : `C1.signal.aborted` passe à `true`. `fetch` et `reader` sont
   annulés ; leur rejet arrivera plus tard, de façon asynchrone.
3. **`abortRef.current = null`** : `C1` n'est plus le flux en cours.
4. **`setMessages([])`**, `setError(null)`, `setStatus("idle")`, une ligne au journal ; puis
   `setUserId("bruno")`. Au rendu suivant : écran vide, au nom de bruno.
5. **Des deltas déjà lus** sont encore distribués : `onDelta` → `updateAssistant` →
   `C1.signal.aborted` est vrai → rien.
6. **Le `await streamChat` de `C1` rejette.** Dans le `catch`, `abortRef.current` vaut `null` (ou
   `C2` si bruno a déjà envoyé une question) : différent de `C1`, **sortie immédiate**. Ni
   `dropEmptyTrailingAssistant`, ni statut, ni journal.
7. **`finally`** : `abortRef.current === controller` est faux, rien n'est remis à `null`. Si `C2`
   existe, il reste le flux en cours, et `stop()` l'arrêtera.

Sans la garde du point 6, le `catch` de `C1` ferait `setStatus("idle")` : si bruno a déjà relancé,
l'écran afficherait « Prêt » pendant son flux, et `dropEmptyTrailingAssistant` retirerait sa bulle
encore vide. Le bouton **Stop** ne passe pas par `reset()` : `abortRef.current` vaut encore `C1`,
le `catch` continue et affiche « arrêt volontaire ».

### `apps/web/src/chat/UserSelect.tsx`

Un `<select>` **contrôlé**, sans état propre : la valeur vient du parent (`value`), le choix
remonte par `onChange(event.target.value)`. L'option `value=""` représente « personne », avec le
libellé `Chargement…` ou `Choisir un utilisateur…`. Désactivé tant que `state !== "ready"` ; en
erreur, « Liste indisponible » en `role="alert"`, annoncé par les lecteurs d'écran.

### `apps/web/src/chat/Chat.tsx`

```tsx
  useEffect(() => {
    const controller = new AbortController();
    fetchUsers(controller.signal)
      .then((list) => {
        setUsers(list);
        setUsersState("ready");
        // Le dernier choix n'est repris que s'il existe encore dans la liste reçue.
        const remembered = readUserId();
        if (list.some((user) => user.id === remembered)) setUserId(remembered);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsersState("error");
      });
    return () => controller.abort();
  }, []);

  const handleUserChange = (next: string) => {
    if (next === userId) return;
    // Géré ici, pas dans un effet : la conversation est vidée dans le même geste que le choix.
    reset();
    setUserId(next);
    writeUserId(next);
  };
```

**Ce que fait le code** :
1. **L'effet**, dépendances `[]` : une seule fois, au montage. Le nettoyage `controller.abort()`
   annule la requête si le composant est démonté avant la réponse (le mode strict de React, en
   développement, monte, démonte et remonte : la première requête est annulée, la seconde
   aboutit). Le `catch` ignore l'annulation ; une vraie panne passe le sélecteur en `error`.
2. **Le dernier choix** (`readUserId`, clé `chatbot.userId` de `localStorage`) n'est repris que
   s'il figure dans la liste reçue.
3. **`handleUserChange`** : même valeur, rien ; sinon `reset()`, le nouvel identifiant, et
   `writeUserId`. `readUserId` et `writeUserId` suivent `readPlacement` : un `try/catch` autour
   de `localStorage`, indisponible en navigation privée.

**Pourquoi c'est écrit ainsi** :
- **Revalider** : `localStorage` se modifie dans la console. Un identifiant retiré de
  `users.json` ne doit pas rester choisi, le serveur répondrait 401 à chaque message. C'est un
  confort, pas une preuve d'identité.
- **Pas de `useEffect` sur `userId`** : un effet s'exécute **après** le rendu, il y aurait un rendu
  avec bruno affiché et la conversation de chloé encore là. Dans un gestionnaire d'événement,
  `reset()` et `setUserId` sont regroupés en un seul rendu. Et la restauration au montage ne
  déclenche pas de `reset` inutile : il n'y a encore aucune conversation.

### `apps/web/src/chat/Composer.tsx`

`Chat.tsx` passe `lockedHint={userId ? undefined : "Choisis un utilisateur pour pouvoir écrire."}`.
Dans `Composer.tsx` :

```tsx
      {lockedHint && (
        <p className="composer__hint" id="composer-hint">
          {lockedHint}
        </p>
      )}
```

**Ce que fait le code** : avec un `lockedHint`, le texte s'affiche au-dessus du champ, le
`textarea` et le bouton sont désactivés (`Boolean(lockedHint)`), le champ est relié au texte par
`aria-describedby="composer-hint"`, et `submit` refuse d'envoyer.

**Pourquoi** : un champ grisé sans raison laisse chercher ce qui ne va pas. Le refus est écrit
dans le composer, puis dans `useChat` (`!userId`), et le serveur répond 401 de toute façon :
l'interface évite une erreur, elle ne protège rien. C'est le serveur qui protège.

## Pour explorer toi-même

- **Voir ce que voit chacun** (un appel Voyage par commande) :
  `npm run search -- --user bruno --mode hybrid "Combien de jours de congé paternité chez Lumen ?"`,
  puis `--user alice` et `--user chloe`. Bruno n'a que `discordinvites.pdf`, alice que le
  règlement, chloé les deux. Sans Voyage : `--mode lexical`.
- **Le SQL exécuté** : ajoute `--sql`. Repère `$3 = groupes de bruno` et
  `AND d.allowed_groups && $3::text[]`.
- **Un utilisateur oublié** : `npm run search -- "test"`, puis `--user zoe` : la `ConfigError`
  de `requireUser`, sans connexion ouverte.
- **Dans `psql`** : `docker compose exec postgres psql -U rag -d rag`, puis :

  ```sql
  SELECT file_name, allowed_groups FROM documents;
  SELECT ARRAY['tech'] && ARRAY['rh'];
  SELECT ARRAY['tech'] && ARRAY['tech'], '{}'::text[] && ARRAY['tech'];
  SELECT ARRAY(SELECT jsonb_array_elements_text('{"a.pdf":["rh"]}'::jsonb -> 'b.pdf'));
  SELECT ARRAY['rh','tech'] IS DISTINCT FROM ARRAY['tech','rh'];
  ```

  À voir : `{rh}` et `{tech}` ; `f`, puis `t` et `f` ; `{}` pour une clé absente (le cas de
  `discordinvites.pdf` dans l'exemple d'`applyAcl`) ; `t` pour un autre ordre, d'où le tri de
  `loadAcl`.
- **Le 401**, serveur lancé :

  ```sh
  curl -i -X POST http://127.0.0.1:3000/api/chat -H "Content-Type: application/json" -d '{}'
  curl -i -X POST http://127.0.0.1:3000/api/chat -H "X-User-Id: zoe" -H "Content-Type: application/json" -d '{}'
  ```

  Les deux : `401` et `{"error":"Utilisateur non identifié."}`, **avant** le `400` que mérite ce
  corps vide. Avec `-H "X-User-Id: bruno"`, c'est le `400` : l'identité passe, le corps est refusé.
  `curl http://127.0.0.1:3000/api/users` : des `id` et `nom`, aucun groupe.
- **L'erreur de compilation** : dans `apps/api/src/rag/scripts/ask.ts`, retire
  `userGroups: user.groupes, ` de l'appel à `retrieve`, puis `npm run typecheck` (ou
  `npx tsc --noEmit -p apps/api`) : le `TS2345` cité plus haut. Remets-le.
- **Un `console.log` dans `applyAcl`**, juste avant le `return` :
  `console.log(JSON.stringify(Object.fromEntries(acl)), rows);`. `npm run ingest` sans rien
  changer : l'ACL envoyée et `rows` vide. Retire une entrée de `acl.json` : une ligne dans `rows`
  et le `🔒 … personne`. Remets l'entrée, relance, retire le `console.log`.
- **Un `console.log("delta", controller.signal.aborted);` dans `updateAssistant`**, avant le
  `if` : change d'utilisateur pendant une réponse, les dernières lignes affichent `true`.
- **La fuite par l'historique**, à la main : commente `reset();` dans `handleUserChange`, pose à
  chloé la question du congé paternité, passe à bruno et demande « Tu peux me le répéter ? ». La
  réponse revient alors que bruno n'a aucun droit sur le règlement : elle vient de l'historique,
  pas de `retrieve`. Remets `reset();`.
