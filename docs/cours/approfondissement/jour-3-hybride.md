# Approfondissement · Jour 3 · Cours 1 — Le code de la recherche hybride

> [← Retour au cours](../jour-3-hybride.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.
>
> **Note.** Le cours suivant (droits d'accès) a ajouté `userGroups` et
> `--user` à plusieurs fonctions citées ici : les extraits les montrent, et
> [l'approfondissement des droits](jour-3-droits.md) les explique.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/src/rag/db/migrations/002_fulltext.sql` | colonne générée `content_tsv` et son index GIN | 1 |
| `apps/api/src/rag/db/repository.ts` | `LEXICAL_SEARCH_SQL`, `searchLexical`, `SearchRow`, `toSearchResult`, sens du `score` | 1, 2, 3 |
| `apps/api/src/rag/retrieve.ts` | `SEARCH_MODES`, `SearchRanks`, `createRetriever` (les trois modes), `fuseByRrf` | 0, 4, 5 |
| `apps/api/src/rag/config.ts` | `loadSearchMode` : lit et valide `RAG_SEARCH_MODE` | 5 |
| `apps/api/src/server.ts` | donne le mode par défaut au `retrieve` de `/chat` | 5 |
| `apps/api/src/rag/scripts/ask.ts` | idem pour `npm run ask` | 5 |
| `apps/api/src/rag/scripts/search.ts` | `npm run search` : `--mode`, `--sql`, `--explain`, `formatRanks` | 2, 3, 4 |
| `apps/api/src/evals/types.ts` | champ `recherche?` de `RunConfig` | 6 |
| `apps/api/src/evals/run.ts` | `eval:run -- --mode …`, mode enregistré dans le run | 6 |
| `apps/api/src/evals/report.ts`, `evals/score.ts` | affichent le mode du run | 6 |
| `apps/api/src/evals/compare.ts` | `npm run eval:compare` : rang du bon passage, run par run | 6 |
| `apps/api/.env.example` | la variable `RAG_SEARCH_MODE` | 5 |
| `package.json`, `apps/api/package.json` | le script `eval:compare` | 6 |

## Le parcours dans le code

Tu lances `npm run search -- --mode hybrid "ns338233"` (le hostname de la machine de prod).

1. **`search.ts` → `main`** (lancé via `npm run search -w apps/api --`) : `parseArgs` lit la
   question et `--mode hybrid` ; sans `--mode`, ce serait `loadSearchMode()`.
2. **`createRetriever({ pool, embedder })`** fabrique `retrieve`, appelé avec
   `{ k: 5, mode: "hybrid" }`.
3. **`retrieve.ts`, la fonction renvoyée** vérifie la question et `k`, puis entre dans le
   `case "hybrid"` : `candidates = 20`.
4. **`Promise.all`** lance en même temps :
   - `searchVector` → `embedder.embedQuery` (appel Voyage) → `searchChunks` (SQL pgvector,
     `LIMIT 20`) : les 13 chunks de la base, triés par distance cosinus ;
   - `searchLexical` → `LEXICAL_SEARCH_SQL` (`LIMIT 20`) : un seul chunk contient le lexème
     `ns338233`, le chunk 1 de `discordinvites.pdf`.
5. **`fuseByRrf({ vector, lexical })`** additionne les `1 / (60 + rang)` de chaque chunk et trie ;
   `.slice(0, 5)` garde les cinq premiers, chacun avec ses `ranks`.
6. **Retour dans `search.ts`** : la ligne d'en-tête « Fusion RRF … », puis pour chaque passage
   `formatRanks(result.ranks)` et le score RRF à 4 décimales :

```text
#1  vecteur #9  · plein texte #1   RRF 0.0309  discordinvites.pdf  p. 1–2  (chunk 1)
#2  vecteur #1  · plein texte —    RRF 0.0164  discordinvites.pdf  p. 4  (chunk 5)
#3  vecteur #2  · plein texte —    RRF 0.0161  discordinvites.pdf  p. 1  (chunk 0)
```

Côté `/chat`, c'est le même chemin à partir de l'étape 3 : `server.ts` a créé `retrieve` avec
`defaultMode: config.rag.searchMode`, et la route l'appelle **sans** `mode`. `chat.ts` n'a pas
changé : la valeur `score` qu'il met dans l'événement `sources` est simplement le score RRF.

## `apps/api/src/rag/db/migrations/002_fulltext.sql`

La deuxième migration, appliquée par `npm run db:migrate` (`runMigrations` passe les fichiers
`.sql` dans l'ordre alphabétique et note chacun dans `schema_migrations`).

```sql
ALTER TABLE chunks
    ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('french', content)) STORED;

-- Index GIN (index inversé) : pour chaque lexème, la liste des chunks qui le
-- contiennent. C'est lui qui rend l'opérateur @@ rapide sur une grande base.
CREATE INDEX chunks_content_tsv_idx ON chunks USING gin (content_tsv);
```

**Ce que fait le code**, dans l'ordre du code :
1. `content_tsv tsvector` : une liste triée de **lexèmes** (mots normalisés) avec leurs positions.
2. `GENERATED ALWAYS AS (…) STORED` en fait une **colonne générée**, calculée par Postgres et
   **stockée** ; l'`ALTER TABLE` la remplit pour les 13 chunks déjà en base.
3. `to_tsvector('french', …)` découpe le texte en jetons, retire les mots vides français (« le »,
   « de », « est »…) et racinise le reste avec le *stemmer* Snowball : « hostname » devient
   `hostnam`, « heures » devient `heur`.
4. `CREATE INDEX … USING gin` crée un index **inversé** : pour chaque lexème, la liste des chunks
   qui le contiennent. C'est l'inverse d'un `tsvector`, qui donne les lexèmes d'un chunk.

**Pourquoi c'est écrit ainsi** :
- **Colonne générée** plutôt qu'un calcul dans `replaceDocument` : l'ingestion n'a pas changé
  d'une ligne, et un `INSERT` ou un `UPDATE` de `content` recalcule la colonne. Impossible
  d'oublier de la tenir à jour.
- **`'french'` en dur** : une expression de colonne générée doit être *immuable*. La forme à un
  argument, `to_tsvector(content)`, dépend du réglage `default_text_search_config` de la session :
  Postgres la refuse.
- **GIN** : sans lui, `@@` teste chaque chunk un par un. Avec 13 chunks, Postgres préfère encore ce
  parcours séquentiel (voir `--explain` plus bas) ; l'index sert quand la base grossit.

## `apps/api/src/rag/db/repository.ts`

Toutes les requêtes SQL du RAG. Quatre ajouts : le sens du `score`, la requête plein texte, sa
fonction, et la conversion des lignes partagée avec la recherche vectorielle.

### Le `score` de `SearchResult`

```ts
  /**
   * Dépend de la recherche : similarité cosinus en vectoriel (1 = même
   * direction, 0 = sans rapport), ts_rank en plein texte (sans borne fixe,
   * comparable seulement entre résultats d'une même question).
   */
  score: number;
```

Le champ garde son nom, mais son sens dépend de la requête. Ordres de grandeur observés : `0.3` à
`0.7` en cosinus, `0.015` à `0.09` en `ts_rank`. En hybride, `fuseByRrf` le remplace par un score
RRF.

### `LEXICAL_SEARCH_SQL`

```ts
export const LEXICAL_SEARCH_SQL = `
WITH q AS (
  SELECT array_to_string(array_agg(quote_literal(lexeme)), ' | ')::tsquery AS query
  FROM unnest(to_tsvector('french', $1))
)
SELECT d.file_name,
       c.chunk_index,
       c.page_start,
       c.page_end,
       c.content,
       ts_rank(c.content_tsv, q.query) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
CROSS JOIN q
WHERE c.content_tsv @@ q.query
ORDER BY score DESC, c.id
LIMIT $2`;
```

**Ce que fait le code**, dans l'ordre du code :
1. **Le CTE `q`** (`WITH q AS (…)`) construit **une seule** valeur, la requête plein texte
   `query`, à partir de la question `$1` :
   - `to_tsvector('french', $1)` normalise la question **exactement comme les chunks** l'ont été
     dans la colonne générée ;
   - `unnest(tsvector)` transforme ce `tsvector` en **lignes**, une par lexème, avec les colonnes
     `lexeme`, `positions` et `weights` ;
   - `quote_literal(lexeme)` entoure chaque lexème d'apostrophes : `next.js` devient `'next.js'` ;
   - `array_agg(…)` regroupe ces lignes en un tableau, `array_to_string(…, ' | ')` le joint en une
     chaîne avec `|` (OU) entre chaque lexème ;
   - `::tsquery` convertit cette chaîne en requête plein texte.
2. **`CROSS JOIN q`** colle cette unique ligne à chaque chunk, pour le `WHERE` et le `SELECT`.
3. **`@@`** : « le `tsvector` correspond à la `tsquery` ». Avec des `|`, un lexème commun suffit.
4. **`ts_rank`** note chaque chunk retenu : plus d'occurrences des lexèmes, score plus haut.
5. **`ORDER BY score DESC, c.id`** puis **`LIMIT $2`** : les `limit` meilleurs.

**Exemple déroulé** : « C'est quoi le hostname de Next.js ? ». Ce que donne chaque étape du CTE,
observé dans `psql` :

| Étape | Résultat |
| --- | --- |
| `to_tsvector('french', $1)` | `'hostnam':5 'next.js':7 'quoi':3` |
| `unnest(…)` | 3 lignes : `hostnam {5}`, `next.js {7}`, `quoi {3}` (colonnes `lexeme`, `positions`) |
| `quote_literal(lexeme)` | `'hostnam'`, `'next.js'`, `'quoi'` |
| `array_to_string(array_agg(…), ' \| ')` | la chaîne `'hostnam' \| 'next.js' \| 'quoi'` |
| `::tsquery` | `'hostnam' \| 'next.js' \| 'quoi'` |

- « C' », « est », « le » et « de » ont disparu : mots vides. `ts_debug` le montre, lexème `{}`
  pour chacun (voir « Pour explorer toi-même »). Leur position, elle, reste comptée : `quoi` est en
  3, `hostnam` en 5.
- `next.js` reste **entier** : l'analyseur de Postgres reconnaît un jeton de type `host` (comme un
  nom de domaine) et ne le coupe pas au point.
- Résultat : 2 chunks sur 13, le chunk 1 de `discordinvites.pdf` (`ts_rank` 0.0253) et le chunk 4
  (0.0203).

**Pourquoi c'est écrit ainsi** :
- **OU plutôt que ET.** `plainto_tsquery('french', …)` sur la même question donne
  `'quoi' & 'hostnam' & 'next.js'` : il faudrait un chunk qui contienne les trois, y compris
  « quoi ». Une question en langage naturel a presque toujours des mots en trop ; en ET, elle ne
  trouverait souvent rien. En OU, chaque mot commun rapporte, et `ts_rank` classe.
- **Le cast `::tsquery` ne re-racinise pas** : `'heures'::tsquery` reste `'heures'`, alors que
  `to_tsquery('french', 'heures')` donne `'heur'`. Les lexèmes sortent de `to_tsvector`, **déjà**
  racinisés : `to_tsquery('french', …)` les re-raciniserait, au risque qu'une racine de racine ne
  corresponde plus à `content_tsv`.
- **`quote_literal`** : dans la syntaxe `tsquery`, `:`, `&`, `|`, `!`, les parenthèses et l'espace
  sont des opérateurs. `'x:y'::tsquery` lève `syntax error in tsquery` ; entre apostrophes, le
  lexème est lu comme un littéral, quel que soit son contenu. Sur les lexèmes de nos documents
  (`next.js`, `discord.gg/abc`), le cast passe aussi sans apostrophes : `quote_literal` est la
  protection, pour le jour où un lexème contiendra un de ces caractères.
- **Le cas NULL.** « Et le la ? » ne contient que des mots vides : `to_tsvector` est vide,
  `unnest` ne produit **aucune** ligne, `array_agg` d'aucune ligne vaut `NULL`,
  `array_to_string(NULL, …)` aussi, et `NULL::tsquery` reste `NULL`. Or `content_tsv @@ NULL` vaut
  `NULL`, que le `WHERE` traite comme faux : 0 ligne, sans erreur. C'est ce que `search.ts` traduit
  par « Aucun chunk ne contient un mot de la question ».
- **`ts_rank`, pas BM25.** `ts_rank` regarde le chunk et la requête, jamais le reste de la base :
  il ne sait pas qu'un mot est rare. BM25 (Elasticsearch, Lucene) pondère au contraire chaque terme
  par sa rareté dans le corpus. Observé : la requête `'le'` (« les » racinisé, voir plus bas) donne
  à chaque chunk un `ts_rank` d'environ 0.09, la requête `'ns338233'` donne 0.061 au seul chunk qui
  le contient. Un mot présent partout n'est pas pénalisé ; c'est acceptable ici parce que les mots
  vides sont déjà retirés et que la fusion n'utilise que les **rangs**.
- **`c.id` en second critère** : sur « le la les », quatre chunks ont exactement 0.0890, trois
  0.0865. Sans ce critère, leur ordre ne serait pas garanti ; avec, le classement est stable.

### `searchLexical()`, `SearchRow` et `toSearchResult()`

```ts
export async function searchLexical(
  pool: pg.Pool,
  question: string,
  limit: number,
  userGroups: readonly string[],
): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchRow>(LEXICAL_SEARCH_SQL, [question, limit, userGroups]);
  return rows.map(toSearchResult);
}

interface SearchRow {
  file_name: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
  score: number;
}

function toSearchResult(row: SearchRow): SearchResult {
  return {
    fileName: row.file_name,
    chunkIndex: row.chunk_index,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    content: row.content,
    score: Number(row.score),
  };
}
```

**Ce que fait le code** :
1. `searchLexical` envoie la **question brute** en paramètre `$1` (jamais collée dans le SQL) :
   c'est Postgres qui la normalise.
2. `pool.query<SearchRow>` annonce à TypeScript la forme des lignes, en `snake_case` comme les
   colonnes SQL : une promesse faite au compilateur, pas une vérification.
3. `toSearchResult` renomme en `camelCase` et force `score` en nombre. `searchChunks` utilise
   désormais les mêmes `SearchRow` et `toSearchResult`, qu'il écrivait en ligne au jour 2.

**Pourquoi c'est écrit ainsi** : les deux requêtes renvoient les mêmes colonnes sous les mêmes
noms ; une seule conversion garantit que `fuseByRrf` reçoit deux listes de forme identique.
`Number(…)` protège des types que `pg` renvoie en chaîne (`numeric`, `bigint`), si une requête
change un jour.

## `apps/api/src/rag/retrieve.ts`

Une question en entrée, des passages classés en sortie. Le fichier gagne les modes, la fusion et
de quoi dire d'où vient chaque passage.

### `SEARCH_MODES`, `SearchMode`, `SearchRanks`, `RetrievedChunk`

```ts
export const SEARCH_MODES = ["vector", "lexical", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** Rang (à partir de 1) obtenu dans chaque recherche ; null si le chunk n'y figurait pas. */
export interface SearchRanks {
  vector: number | null;
  lexical: number | null;
}

/**
 * Un passage retrouvé, avec de quoi le citer. En mode hybrid, score est le
 * score RRF et ranks dit d'où vient le passage.
 */
export type RetrievedChunk = SearchResult & { ranks?: SearchRanks };
```

**Ce que fait le code** :
1. `as const` fige le tableau en tuple `readonly ["vector", "lexical", "hybrid"]` ;
   `(typeof SEARCH_MODES)[number]`, le type d'un élément, donne l'union des trois chaînes.
2. `SearchRanks` note le rang (1 = premier) dans chaque recherche, ou `null`.
3. `RetrievedChunk` était un simple alias de `SearchResult` ; c'est maintenant une
   **intersection** avec un champ **optionnel** `ranks`, rempli seulement en mode hybride.

**Pourquoi c'est écrit ainsi** :
- Une seule liste sert à la fois de **valeur** (vérifier `--mode` ou `RAG_SEARCH_MODE` à
  l'exécution, afficher l'usage avec `SEARCH_MODES.join("|")`) et de **type** (le `switch`, les
  paramètres). Ajouter un mode à la liste l'ajoute partout.
- `ranks?` optionnel : la route, `buildRagPrompt` et `eval:run` manipulent toujours des
  `RetrievedChunk` sans s'en soucier. Seul `search.ts` le lit.

### `createRetriever()`

Deux constantes l'accompagnent : `HYBRID_CANDIDATES = 20` (candidats demandés à chaque recherche
avant la fusion) et `RRF_K = 60` (la valeur du papier d'origine, Cormack et al., 2009). Elles sont
**exportées** : `eval:run` les recopie dans la configuration du run, `search.ts` les affiche.

```ts
export function createRetriever({ pool, embedder, defaultMode = "vector" }: RetrieverDeps): Retrieve {
  // La question devient un vecteur (input_type: "query"), puis les chunks
  // les plus proches, triés par distance cosinus croissante.
  async function searchVector(
    text: string,
    limit: number,
    userGroups: readonly string[],
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const queryVector = await embedder.embedQuery(text, { signal });
    return searchChunks(pool, queryVector, limit, userGroups);
  }

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

    switch (mode) {
      case "vector":
        return searchVector(text, k, userGroups, signal);
      case "lexical":
        // Aucun appel au fournisseur d'embeddings : tout se passe dans Postgres.
        return searchLexical(pool, text, k, userGroups);
      case "hybrid": {
        // Les deux recherches sont indépendantes : on les lance en même temps,
        // la durée totale est celle de la plus lente (l'appel Voyage).
        // Toutes deux filtrent sur userGroups : la fusion ne reçoit que des
        // chunks autorisés. Une seule branche filtrée suffirait à faire fuiter
        // les chunks interdits trouvés par l'autre.
        const candidates = Math.max(HYBRID_CANDIDATES, k);
        const [vector, lexical] = await Promise.all([
          searchVector(text, candidates, userGroups, signal),
          searchLexical(pool, text, candidates, userGroups),
        ]);
        return fuseByRrf({ vector, lexical }).slice(0, k);
      }
    }
  };
}
```

**Ce que fait le code**, dans l'ordre du code :
1. **`defaultMode = "vector"`** : sans mode à la création, le comportement d'avant la recherche
   hybride.
2. **`searchVector`**, fonction **interne**, voit `pool` et `embedder` par fermeture : ce sont
   les deux étapes du jour 2 (embedding, puis requête pgvector), avec un `limit` en paramètre.
3. **La fonction renvoyée** : `mode = defaultMode`, le mode passé à l'appel l'emporte ; puis les
   vérifications du jour 2 (question vide, `k` entre 1 et 50).
4. **`switch (mode)`** : `"vector"`, le jour 2 ; `"lexical"`, `searchLexical` sans embedding ni
   `signal` ; `"hybrid"`, les deux recherches, la fusion, puis `.slice(0, k)`.
5. **`Math.max(HYBRID_CANDIDATES, k)`** : 20 candidats, ou `k` s'il est plus grand.
6. **`Promise.all([...])`** démarre les deux promesses **avant** d'attendre, et se résout avec
   leurs deux résultats dans l'ordre du tableau d'entrée, nommés par `[vector, lexical]`.

**Pourquoi c'est écrit ainsi** :
- **En parallèle** : la requête plein texte prend moins d'une milliseconde, l'appel Voyage
  plusieurs centaines ; l'hybride dure à peu près autant que le vectoriel.
- **`Promise.all` échoue dès qu'une des deux échoue** : la route en fait une `RetrievalError`
  comme au jour 2. Pas de repli silencieux sur une seule recherche, moins bonne sans que personne
  le sache.
- **20 candidats pour en garder 5** : un passage 9e en vectoriel et 1er en plein texte doit
  pouvoir remonter ; avec 5 candidats, la fusion ne le verrait pas (« ns338233 », plus bas).
- **Pas de `default`** : les trois `case` couvrent `SearchMode` et renvoient tous ; un quatrième
  mode ajouté sans `case` ferait échouer la compilation (la fonction pourrait ne rien renvoyer).

### `fuseByRrf()`

```ts
export function fuseByRrf(lists: Record<keyof SearchRanks, SearchResult[]>): RetrievedChunk[] {
  const fused = new Map<string, SearchResult & { ranks: SearchRanks }>();

  for (const name of ["vector", "lexical"] as const) {
    lists[name].forEach((chunk, i) => {
      const rank = i + 1;
      // Un chunk est identifié par son document et sa position dans celui-ci.
      const key = `${chunk.fileName}#${chunk.chunkIndex}`;
      const entry = fused.get(key) ?? { ...chunk, score: 0, ranks: { vector: null, lexical: null } };
      entry.ranks[name] = rank;
      entry.score += 1 / (RRF_K + rank);
      fused.set(key, entry);
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}
```

**Ce que fait le code**, dans l'ordre du code :
1. **La signature** : `Record<keyof SearchRanks, SearchResult[]>` vaut
   `{ vector: SearchResult[]; lexical: SearchResult[] }`, les mêmes clés que `SearchRanks`.
2. **`fused`** : une `Map` de l'identifiant du chunk vers le chunk, son score cumulé et ses rangs.
   Une `Map` garde l'**ordre d'insertion**.
3. **La boucle** parcourt la liste vectorielle, puis la liste plein texte ; `as const` donne à
   `name` le type `"vector" | "lexical"`, ce qui autorise `lists[name]` et `entry.ranks[name]`.
4. Pour chaque chunk : `rank = i + 1` (les listes arrivent **déjà triées** par leur SQL) ;
   `fused.get(key) ?? { … }` reprend l'entrée existante ou en crée une, **copie** du chunk avec
   `score: 0` et deux rangs à `null` ; le rang est noté, `1 / (60 + rang)` s'ajoute au score.
   `fused.set` sur une clé existante ne change pas sa position.
5. **`[...fused.values()]`** en fait un tableau, trié par score décroissant.

**Exemple déroulé** : « ns338233 », la sortie citée dans le parcours. Il y a 13 chunks en base.

- `lists.vector` : les 13 chunks (le `LIMIT 20` ne coupe rien), triés par similarité cosinus. Rang
  1 : `discordinvites.pdf#5` (p. 4) ; rang 2 : `discordinvites.pdf#0` (p. 1) ; … ; rang 9 :
  `discordinvites.pdf#1` (p. 1–2) ; … ; rang 13.
- `lists.lexical` : un seul chunk, `discordinvites.pdf#1`, le seul dont `content_tsv` contient
  `ns338233` (`ts_rank` 0.061).

**Passe `"vector"`** : la `Map` est vide, chaque chunk crée son entrée.

| `i` | rang | clé | entrée après l'étape |
| --- | --- | --- | --- |
| 0 | 1 | `discordinvites.pdf#5` | nouvelle ; `ranks { vector: 1, lexical: null }`, score 1/61 = 0.01639 |
| 1 | 2 | `discordinvites.pdf#0` | nouvelle ; `ranks { vector: 2, lexical: null }`, score 1/62 = 0.01613 |
| 2 à 7 | 3 à 8 | six autres chunks | nouvelles ; de 1/63 = 0.01587 à 1/68 = 0.01471 |
| 8 | 9 | `discordinvites.pdf#1` | nouvelle ; `ranks { vector: 9, lexical: null }`, score 1/69 = 0.01449 |
| 9 à 12 | 10 à 13 | quatre autres chunks | nouvelles ; de 1/70 = 0.01429 à 1/73 = 0.01370 |

Après cette passe, la `Map` a 13 entrées, et leurs scores suivent l'ordre vectoriel.

**Passe `"lexical"`** :

| `i` | rang | clé | entrée après l'étape |
| --- | --- | --- | --- |
| 0 | 1 | `discordinvites.pdf#1` | **existante** ; `ranks { vector: 9, lexical: 1 }`, score 1/69 + 1/61 |

Le calcul : 1/69 + 1/61 = 0.014493 + 0.016393 = **0.030886**, affiché `0.0309`.

**Le tri** : `discordinvites.pdf#1` (0.0309) passe devant tout le monde ; suivent
`discordinvites.pdf#5` (0.0164) et `discordinvites.pdf#0` (0.0161), puis les rangs vectoriels 3,
4… `.slice(0, 5)` (dans `createRetriever`) garde les cinq premiers. Le passage qui contient le
hostname, 9e en vectoriel, donc **hors** des 5 passages envoyés au modèle en mode `vector`, arrive
1er.

**Pourquoi c'est écrit ainsi** :
- **Les rangs, jamais les scores.** Une similarité cosinus (≈ 0,4) et un `ts_rank` (≈ 0,05) ne
  sont pas sur la même échelle ; les additionner donnerait tout le poids au vectoriel. Un rang,
  lui, a le même sens dans les deux listes.
- **`RRF_K = 60` aplatit les écarts** : 1/61 pour le 1er, 1/62 pour le 2e, 1/69 pour le 9e. Être
  1er plutôt que 9e dans une liste ne rapporte que 0.0019 de plus ; être **présent dans les deux**
  rapporte une contribution entière en plus. C'est l'accord entre les deux recherches qui fait
  monter un passage.
- **Clé `fichier#index`** : `SearchResult` ne transporte pas l'`id` SQL, et
  `(document, chunk_index)` est unique en base.
- **Ordre à égalité** : `Array.prototype.sort` est **stable** en JavaScript. Deux chunks au même
  score RRF gardent l'ordre de la `Map`, c'est-à-dire l'ordre d'insertion : liste vectorielle
  d'abord. Exemple : le 1er du vectoriel seul et le 1er du plein texte seul ont tous deux 1/61 ;
  le vectoriel sort devant.

## `apps/api/src/rag/config.ts`

### `loadSearchMode()`

```ts
export function loadSearchMode(): SearchMode {
  loadDotEnv();
  const raw = process.env["RAG_SEARCH_MODE"]?.trim() || "vector";
  if (!(SEARCH_MODES as readonly string[]).includes(raw)) {
    throw new ConfigError(`RAG_SEARCH_MODE doit valoir ${SEARCH_MODES.join(", ")} (reçu : "${raw}").`);
  }
  return raw as SearchMode;
}
```

**Ce que fait le code**, dans l'ordre du code :
1. `loadDotEnv()` charge `apps/api/.env` s'il existe.
2. `|| "vector"` remplace **absente** et **vide** (`""`) par `"vector"` ; un `??` ne remplacerait
   que l'absente.
3. `includes` sur le tuple n'accepte qu'une des trois chaînes : `as readonly string[]` élargit le
   type pour tester une `string` quelconque. Inconnue : une `ConfigError`. Connue : le cast
   `raw as SearchMode` est sûr, la ligne d'avant l'a vérifié.

**Pourquoi c'est écrit ainsi** :
- **Optionnelle** à la différence de `DATABASE_URL` (`requireEnv`) : un `.env` écrit avant ce
  cours continue de marcher, en vectoriel.
- **`ConfigError`** : le serveur l'attrape dans `loadConfigOrExit` et s'arrête au démarrage avec
  `[config] RAG_SEARCH_MODE doit valoir vector, lexical, hybrid (reçu : "hybride").`, au lieu d'une
  faute de frappe découverte à la première question.

## Le branchement de `defaultMode`

### `apps/api/src/server.ts`

```ts
const retrieve = createRetriever({
  pool,
  embedder: createEmbeddingClient(config.rag.embedding),
  defaultMode: config.rag.searchMode,
});
```

Et, dans `loadConfigOrExit()` :

```ts
      rag: {
        databaseUrl: loadDatabaseConfig().databaseUrl,
        embedding: loadEmbeddingConfig(),
        searchMode: loadSearchMode(),
      },
```

**Ce que fait le code** : le mode est lu avec le reste de la configuration RAG, dans le même
`try`, et devient le mode par défaut. `/chat` appelle `retrieve` sans `mode` : celui du `.env`.

**Pourquoi c'est écrit ainsi** : changer de recherche pour `/chat`, c'est modifier
`RAG_SEARCH_MODE` et redémarrer. `chat.ts` ne connaît pas les modes.

### `apps/api/src/rag/scripts/ask.ts`

```ts
    const retrieve = createRetriever({
      pool,
      embedder: createEmbeddingClient(loadEmbeddingConfig()),
      defaultMode: loadSearchMode(),
    });
```

Même branchement : `npm run ask` montre ce que `/chat` ferait avec le même `.env`. Le script n'a
pas d'option `--mode` ; pour comparer les modes sur une question, c'est `npm run search`.

## `apps/api/src/rag/scripts/search.ts`

`npm run search` : le terminal de la recherche, sans modèle. C'est l'outil des leçons 2 à 4.

### Les options et le mode

```ts
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      // Sans --mode : celui de RAG_SEARCH_MODE, comme /chat.
      user: { type: "string" },
      mode: { type: "string" },
      sql: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
    },
  });

  const question = positionals.join(" ").trim();
  const mode = (values.mode ?? loadSearchMode()) as SearchMode;
  if (question === "" || !SEARCH_MODES.includes(mode)) {
    console.error(
      `Usage : npm run search -- --user <id> "ma question" [--mode ${SEARCH_MODES.join("|")}] [--sql] [--explain]`,
    );
    process.exitCode = 1;
    return;
  }
```

**Ce que fait le code** :
1. `values.mode ?? loadSearchMode()` : l'option si elle est donnée, sinon le `.env`.
2. Le `as SearchMode` vient **avant** la vérification : c'est un mensonge temporaire au
   compilateur, qui permet d'appeler `SEARCH_MODES.includes(mode)` sans le cast inverse de
   `config.ts`. La ligne suivante rétablit la vérité à l'exécution : `--mode hybride` affiche
   l'usage et sort avec le code 1.
3. Plus bas, `createRetriever({ pool, embedder })` sans `defaultMode`, et
   `retrieve(question, { k: DEFAULT_K, mode })` : le mode est toujours passé à l'appel.

### `--sql`

```ts
    if (values.sql) {
      // En hybride, chaque requête demande HYBRID_CANDIDATES chunks, puis la fusion se fait en TypeScript.
      const limit = mode === "hybrid" ? HYBRID_CANDIDATES : DEFAULT_K;
      if (mode !== "lexical") console.log(`Requête vectorielle ($1 = vecteur de la question, $2 = ${limit}, $3 = groupes de ${user.id}) :${SEARCH_SQL}\n`);
      if (mode !== "vector") console.log(`Requête plein texte ($1 = texte de la question, $2 = ${limit}, $3 = groupes de ${user.id}) :${LEXICAL_SEARCH_SQL}\n`);
    }
```

Affiche la ou les requêtes exécutées, avec la valeur de `$2`. Les deux tests en négatif
(`!== "lexical"`, `!== "vector"`) couvrent les trois modes : `hybrid` affiche les deux. La fusion
n'apparaît pas : elle ne se passe pas en SQL.

### L'affichage et `formatRanks()`

```ts
    results.forEach((result, rank) => {
      const excerpt = result.content.replace(/\s+/g, " ");
      // En hybride : d'où vient le passage, puis son score fusionné (4 décimales, les écarts sont petits).
      const score = result.ranks
        ? `${formatRanks(result.ranks)}  RRF ${result.score.toFixed(4)}`
        : `score ${result.score.toFixed(3)}`;
      console.log(`#${rank + 1}  ${score}  ${result.fileName}  ${formatPages(result)}  (chunk ${result.chunkIndex})`);
      console.log(`    ${excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt}\n`);
    });
```

```ts
/** « vecteur #2 · plein texte — » : le rang dans chaque recherche, « — » si absent. */
function formatRanks({ vector, lexical }: SearchRanks): string {
  const rank = (value: number | null) => (value === null ? "—" : `#${value}`).padEnd(3);
  return `vecteur ${rank(vector)} · plein texte ${rank(lexical)}`;
}
```

**Ce que fait le code** :
1. C'est la **présence** de `ranks` qui choisit le format, pas le mode : seul `fuseByRrf` le
   remplit.
2. `formatRanks` : `null` devient `—`, un rang `#9`, et `padEnd(3)` les élargit à la taille de
   `#12` : les colonnes restent alignées (d'où les espaces de `vecteur #9  · plein texte #1   `).
3. Le score RRF a **4 décimales** : à 3, 0.0164 et 0.0161 s'afficheraient tous deux `0.016`.

### `--explain`

```ts
    if (values.explain && mode !== "vector") {
      // Le texte de la question suffit : pas de vecteur à fabriquer.
      const { rows } = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE ${LEXICAL_SEARCH_SQL}`, [
        question,
        DEFAULT_K,
      ]);
      console.log("Plan d'exécution (plein texte) :");
      for (const row of rows) console.log(`  ${row["QUERY PLAN"]}`);
    }
```

**Ce que fait le code** : `EXPLAIN ANALYZE` exécute la requête **et** renvoie son plan, une
ligne par résultat dans la colonne `"QUERY PLAN"`. Le plan plein texte utilise la vraie question
(gratuit) ; le plan vectoriel, en `vector` et `hybrid`, garde le vecteur fabriqué du jour 2.

Sur « ns338233 », le plan observé contient `Function Scan on unnest` puis `Aggregate` (le CTE),
`Seq Scan on chunks c (… rows=13 …)` et `Rows Removed by Join Filter: 12`. L'index GIN n'est pas
utilisé : pour 13 lignes, un parcours séquentiel coûte moins cher. Le plan changera avec la base.

## L'évaluation : `types.ts`, `run.ts`, `report.ts`, `score.ts`

### `RunConfig.recherche` (`apps/api/src/evals/types.ts`)

```ts
  /**
   * Recherche utilisée. Absente dans les runs antérieurs à la recherche
   * hybride : ils ont tous été faits en vectoriel.
   */
  recherche?: { mode: string; candidats_par_recherche?: number; rrf_k?: number };
```

Le champ est **optionnel** : les runs du jour 2, déjà sur le disque, n'en ont pas et doivent
rester lisibles. `mode` est une `string` et non un `SearchMode` : c'est la forme du JSON lu sur
le disque, pas une valeur validée. Les deux réglages de la fusion ne sont présents qu'en hybride.

### `--mode` (`apps/api/src/evals/run.ts`)

```ts
  const { values } = parseArgs({
    options: { user: { type: "string" }, only: { type: "string" }, mode: { type: "string" } },
  });
  // Obligatoire, sans défaut : un run mesure ce que voit un utilisateur donné.
  const user = await requireUser(values.user);
  // Sans --mode : celui de RAG_SEARCH_MODE, comme /chat.
  const mode = (values.mode ?? loadSearchMode()) as SearchMode;
  if (!SEARCH_MODES.includes(mode)) {
    console.error(`--mode doit valoir ${SEARCH_MODES.join(", ")} (reçu : "${mode}").`);
    process.exitCode = 1;
    return;
  }
```

Plus bas, dans la `RunConfig` :

```ts
      recherche:
        mode === "hybrid" ? { mode, candidats_par_recherche: HYBRID_CANDIDATES, rrf_k: RRF_K } : { mode },
```

**Ce que fait le code** :
1. Même logique que `search.ts`, mais **avant** `loadConfig()` et toute connexion : un mode mal
   écrit s'arrête avant le premier appel payant.
2. Le mode devient le `defaultMode` du `retrieve` du run (`createRetriever({ …, defaultMode: mode })`) ;
   `runQuestion` n'a pas changé et appelle toujours `retrieve(question.question, { k: DEFAULT_K })`.
3. La configuration enregistre le mode, et en hybride les constantes **importées** de
   `retrieve.ts` ; la ligne d'état du début affiche `recherche ${mode}`.

**Pourquoi c'est écrit ainsi** : le run dit comment il a été produit. Le `score` des chunks d'un
run hybride est un score RRF (2/61 ≈ 0.033 au plus), celui d'un run lexical un `ts_rank` (`0.036`,
`0.024`… observés) : sans `recherche.mode`, ces nombres seraient illisibles.

### L'affichage du mode (`report.ts`, `score.ts`)

Dans `renderReport` (`apps/api/src/evals/report.ts`) :

```ts
    `recherche ${config.recherche?.mode ?? "vector"} · utilisateur ${config.utilisateur?.id ?? "(avant les droits)"} · ` +
      `k = ${config.k} · commit ${config.commit}`,
```

Dans `main` (`apps/api/src/evals/score.ts`) :

```ts
  console.log(`Run ${runId} · ${run.config.llm.modele} · recherche ${run.config.recherche?.mode ?? "vector"} · k=${run.config.k} · commit ${run.config.commit}\n`);
```

`?.` puis `?? "vector"` : un ancien run sans `recherche` s'affiche en `vector`, ce qu'il était.
La même règle est écrite dans `modeOf` de `compare.ts`.

## `apps/api/src/evals/compare.ts`

`npm run eval:compare -- <A> <B> [<C>…]` : pour chaque question, **le rang** auquel le bon passage
apparaît dans chaque run, calculé à partir des pages attendues de `questions.json`. Aucune note
manuelle n'est nécessaire.

### L'en-tête et les runs

```ts
  const questions = z.array(questionSchema).parse(JSON.parse(await readFile(QUESTIONS_FILE, "utf8")));
  const runs = await Promise.all(args.map(loadRun));
  const labels = runs.map((_, i) => String.fromCharCode(65 + i)); // A, B, C…

  console.log("Runs");
  runs.forEach(({ id, run }, i) => {
    console.log(
      `  ${labels[i]}  ${id}  recherche ${modeOf(run).padEnd(7)}  ` +
        `utilisateur ${(run.config.utilisateur?.id ?? "—").padEnd(6)}  commit ${run.config.commit}`,
    );
  });
  warnIfNotComparable(runs.map((r) => r.run));
```

**Ce que fait le code** :
1. Avant ce bloc, moins de deux arguments affichent l'usage (code de sortie 1).
2. Les questions sont relues et validées par Zod : ce sont **elles** qui donnent les pages
   attendues. `loadRun` lit chaque run (identifiant ou chemin, même expression que `score.ts`).
3. `String.fromCharCode(65 + i)` : 65 est le code de « A ». Puis une ligne par run (mode, commit)
   et l'avertissement éventuel.

### La boucle par question

```ts
  const found = runs.map(() => new Set<string>());
  // Plus strict : toutes les sources attendues sont au 1er rang (combinaison : une au 1er, l'autre au 2e).
  const first = runs.map(() => new Set<string>());
  for (const question of answerable) {
    const cells = runs.map(({ run }, i) => {
      const result = run.resultats.find((r) => r.id === question.id);
      if (!result) return "—";
      if (result.erreur) return "erreur";
      const ranks = question.sources_attendues.map((source) => rankOf(source, result.chunks_recuperes));
      // Une question à plusieurs sources (combinaison) n'est trouvée que si toutes le sont.
      if (ranks.every((rank) => rank !== null && rank <= TOP)) found[i]!.add(question.id);
      if ([...ranks].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)).every((rank, j) => rank === j + 1)) first[i]!.add(question.id);
      return ranks.map((rank) => (rank === null ? "absent" : String(rank))).join(" + ");
    });
```

**Ce que fait le code**, dans l'ordre du code :
1. **`found` et `first`** : un `Set` d'ids par run, pour le top 5 et pour le 1er rang.
2. **`answerable`** (défini plus haut) ne garde que `avec_reponse: true` : une question sans
   réponse n'a pas de bon passage à chercher.
3. Résultat absent (run fait avec `--only`) : `—` ; en erreur : `erreur`. Ni l'un ni l'autre
   n'entre dans les `Set`.
4. **`ranks`** : un rang par source attendue, dans l'ordre de `sources_attendues` (`rankOf`).
5. **Top 5** : `every` exige que **toutes** les sources aient un rang non nul et `<= TOP`.
6. **1er rang** : on trie une **copie** des rangs (`[...ranks]`), les `null` envoyés à la fin
   (`?? Infinity`), puis on exige que le rang trié n° `j` vaille `j + 1`. Une source : le rang
   doit valoir 1. Deux sources : les rangs triés doivent valoir `[1, 2]`.
7. **La cellule** : les rangs joints par « + », `absent` pour un `null`. Ils restent dans l'ordre
   des sources attendues, d'où la copie au point 6 : `sort` trie **en place**, et trier `ranks`
   lui-même aurait changé l'affichage.

**Pourquoi c'est écrit ainsi** :
- **Combinaison = toutes les sources.** Une question qui croise deux pages n'a de bonne réponse
  possible que si le modèle reçoit les deux. En trouver une seule n'est pas un succès.
- **Le 1er rang, en plus du top 5.** Avec 13 chunks en base, 5 chunks en couvrent déjà une grande
  part : le top 5 sature vite et ne départage plus les modes. Le 1er rang dit si le bon passage
  arrive **en tête**. Pour une combinaison, deux passages ne peuvent pas être tous deux 1er ; le
  meilleur possible est « 1er et 2e », d'où la comparaison à `j + 1`.

### `rankOf()`

```ts
function rankOf(expected: Source, chunks: RunFile["resultats"][number]["chunks_recuperes"]): number | null {
  const match = chunks
    .filter((chunk) => chunk.fichier === expected.fichier && chunk.pages.some((page) => expected.pages.includes(page)))
    .sort((a, b) => a.rang - b.rang)[0];
  return match?.rang ?? null;
}
```

**Ce que fait le code** :
1. Le type du paramètre se lit de gauche à droite : `RunFile`, son champ `resultats`, `[number]`
   pour **un** élément de ce tableau, puis son champ `chunks_recuperes`.
2. `filter` garde les chunks du **même fichier** ayant **au moins une page en commun** avec la
   source attendue (`some` + `includes`) ; `sort` par rang, `[0]` : le meilleur rang.
3. Aucun chunk ne convient : `match` vaut `undefined`, et `match?.rang ?? null` renvoie `null`.

**Pourquoi c'est écrit ainsi** :
- **Une page commune suffit** : un chunk coupe le texte sans respecter les pages. Le passage
  attendu en p. 1 peut se trouver dans un chunk « p. 1–2 ». Exiger les mêmes pages exactement
  raterait ces cas.
- **Le revers** : ce n'est qu'une approximation. Un chunk « p. 1–2 » qui ne contient que la fin
  de la page 1 compte comme trouvé, même si la phrase utile est ailleurs sur la page. C'est le prix
  d'une mesure automatique ; la notation manuelle d'`eval:score` reste la référence.

**Exemple déroulé : q15**, la combinaison « Pourquoi le front est-il passé sur Next.js, et quels
modes de génération de pages ont été envisagés ? ». Elle attend deux sources :
`discordinvites.pdf` p. 1 et `discordinvites.pdf` p. 3.

*Le run vectoriel `2026-10-13T16-09-47` affiche « 2 + 1 ».* Ses rangs 1 et 2 couvrent p. 3–4 et
p. 1–2.
- `rankOf(p. 1)` → 2, `rankOf(p. 3)` → 1 ; `ranks = [2, 1]`, cellule `2 + 1`.
- Top 5 : 2 ≤ 5 et 1 ≤ 5, q15 entre dans `found`.
- 1er rang : copie triée `[1, 2]` ; `j = 0` : 1 = 1, `j = 1` : 2 = 2. q15 entre dans `first`.

*Le run lexical `2026-10-14T16-40-54`.* Ses `chunks_recuperes` pour q15 :

| rang | fichier | pages |
| --- | --- | --- |
| 1 | `discordinvites.pdf` | 3, 4 |
| 2 | `discordinvites.pdf` | 2, 3 |
| 3 | `discordinvites.pdf` | 4 |
| 4 | `discordinvites.pdf` | 1, 2 |
| 5 | `reglement-interieur.pdf` | 3 |

- `rankOf(p. 1)` : seul le rang 4 (p. 1–2) a la page 1 → 4.
- `rankOf(p. 3)` : les rangs 1 (p. 3–4) et 2 (p. 2–3) conviennent ; le tri garde le rang 1 → 1.
  Le rang 5, page 3 aussi, est écarté : mauvais fichier.
- `ranks = [4, 1]`, cellule `4 + 1`. Top 5 : oui. 1er rang : copie triée `[1, 4]`, et pour
  `j = 1`, 4 ≠ 2 : non. Seule la seconde série de totaux voit la différence entre les deux runs.

### Les totaux et `printTotals()`

```ts
  function printTotals(label: string, subset: EvalQuestion[], foundByRun: Set<string>[]): void {
    const cells = foundByRun.map((set) => `${subset.filter((q) => set.has(q.id)).length}/${subset.length}`);
    console.log(`  ${label.padEnd(15)} ${cells.map((cell) => cell.padStart(COL)).join("")}`);
  }
```

Pour un sous-ensemble de questions, compte celles présentes dans le `Set` de chaque run
(`12/16`). **Déclarée dans `main`**, elle voit `COL`. `main` l'appelle pour le total puis pour
chaque type présent, d'abord avec `found` (top 5), ensuite avec `first` (1er rang).

### `warnIfNotComparable()`

```ts
function warnIfNotComparable(runs: RunFile[]): void {
  const checks: [string, (run: RunFile) => unknown][] = [
    ["questions", (run) => run.config.sha256_questions],
    ["documents", (run) => run.config.documents],
    ["embeddings", (run) => run.config.embeddings],
    ["découpage", (run) => run.config.decoupage],
    ["k", (run) => run.config.k],
  ];
  const differing = checks
    .filter(([, read]) => new Set(runs.map((run) => JSON.stringify(read(run)))).size > 1)
    .map(([name]) => name);
  if (differing.length > 0) {
    console.log(`\n⚠ Les runs diffèrent aussi par : ${differing.join(", ")}. La comparaison ne mesure pas que la recherche.`);
  }
}
```

**Ce que fait le code** :
1. `checks` : des paires « nom affiché, fonction qui lit la valeur dans un run ».
2. Pour chaque paire (`[, read]` saute le nom), la valeur de chaque run est **sérialisée** puis
   placée dans un `Set` : taille 1, tous identiques ; plus, au moins une différence.
3. Les noms des paires qui diffèrent donnent **un avertissement**, pas une erreur.

**Pourquoi c'est écrit ainsi** :
- `JSON.stringify` parce que `documents` et `embeddings` sont des objets : deux objets égaux mais
  distincts sont toujours différents pour un `Set`, leurs chaînes JSON non.
- **Ce qui est vérifié** : tout ce qui change les chunks récupérés. **Ce qui ne l'est pas** : le
  modèle, l'effort, le prompt système, qui n'agissent qu'après la recherche ; et le commit, qui
  change forcément entre deux versions du code.

### `modeOf()` et `formatSources()`

```ts
/** Les runs d'avant la recherche hybride n'enregistraient pas de mode : ils étaient vectoriels. */
function modeOf(run: RunFile): string {
  return run.config.recherche?.mode ?? "vector";
}
```

`modeOf` applique la règle des runs anciens ; `padEnd(7)` dans l'en-tête aligne `vector`,
`lexical` et `hybrid`. `formatSources` écrit les pages attendues sans `.pdf`, sources jointes par
« + » : `discordinvites p. 1 + discordinvites p. 3` pour q15.

## `apps/api/.env.example` et les scripts npm

```text
# Recherche utilisée par /chat et par les scripts : vector, lexical ou hybrid.
# Optionnelle (vector si absente). Voir docs/cours/jour-3-hybride.md.
RAG_SEARCH_MODE=vector
```

Copier `.env.example` ne change pas le comportement ; ajoute la ligne à ton `.env` pour passer
`/chat` en `hybrid`.

Les scripts npm : `"eval:compare": "tsx src/evals/compare.ts"` dans `apps/api/package.json`,
et `"eval:compare": "npm run eval:compare -w apps/api --"` à la racine, dont le `--` final fait
suivre les identifiants des runs. `eval:compare` ne lit que des fichiers : ni Voyage, ni
Anthropic, ni la base.

## Pour explorer toi-même

- **Comparer les modes** : `npm run search -- --mode lexical "ns338233"` (sans Voyage), puis
  `--mode vector` et `--mode hybrid`. Retrouve le chunk 1 au 9e rang en `vector`, et refais le
  0.0309 de l'hybride à la main : 1/69 + 1/61.
- **Une question sans mot utile** : `npm run search -- --mode lexical "Et le la ?"` affiche
  « Aucun chunk ne contient un mot de la question (après normalisation). » Essaie ensuite
  `"le la les"` : tous les chunks sortent. Le paragraphe `ts_debug` ci-dessous explique pourquoi.
- **Voir le SQL et le plan** : `npm run search -- --mode hybrid --sql "hostname Next.js"`, puis
  `npm run search -- --mode lexical --explain "ns338233"`. Repère `Seq Scan on chunks` et
  `Rows Removed by Join Filter`.
- **Dans `psql`** : `docker compose exec postgres psql -U rag -d rag`, puis :

  ```sql
  SELECT alias, token, lexemes FROM ts_debug('french', 'ns338233 next.js 37 heures');
  SELECT alias, token, lexemes FROM ts_debug('french', 'C''est quoi le hostname');
  SELECT to_tsvector('french', 'le la les');
  SELECT 'heures'::tsquery, to_tsquery('french', 'heures');
  SELECT plainto_tsquery('french', 'C''est quoi le hostname de Next.js ?');
  SELECT lexeme, positions FROM unnest(to_tsvector('french', 'C''est quoi le hostname de Next.js ?'));
  ```

  À voir : `ns338233` est un `numword` gardé tel quel, `next.js` un `host`, « heures » donne
  `heur` ; « C' », « est », « le » ont un lexème vide `{}` (mots vides) ; « les », absent de la
  liste, a pour racine `le` (d'où les résultats de « le la les ») ; `plainto_tsquery` relie par `&`.
- **Un `console.log` dans `fuseByRrf`**, juste après `fused.set(key, entry);` :
  `console.log(name, rank, key, entry.ranks, entry.score.toFixed(4));`. Avec
  `npm run search -- --mode hybrid "ns338233"` : 13 lignes `vector`, puis une seule `lexical`,
  dont l'entrée a déjà `vector: 9`. Retire la ligne ensuite.
- **Comparer des runs existants** (lecture de fichiers seulement) :

  ```sh
  npm run eval:compare -- 2026-10-13T16-09-47 2026-10-14T16-40-54
  ```

  Le premier run n'a pas de `recherche` : l'en-tête l'affiche en `vector`. Repère la ligne q15
  (`2 + 1` puis `4 + 1`) et compare les deux séries de totaux. Avec un run hybride en plus :
  `npm run eval:compare -- <A> <B> <C>`.
- **Une faute dans le `.env`** : `RAG_SEARCH_MODE=hybride`, puis `npm run search -- "test"` (sans
  `--mode`) : le message de la `ConfigError` de `loadSearchMode`, et aucun appel Voyage.
