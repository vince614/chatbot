# Jour 2 · Cours 1 — L'ingestion d'un RAG

> [Sommaire](README.md) · Précédent : [Jour 1 · Cours 2 — Le tool use](jour-1-appel-doutils.md)

> **Prérequis.** Avoir suivi les deux cours du jour 1,
> [le flux d'un message](jour-1-flux-dun-message.md) et
> [le tool use](jour-1-appel-doutils.md). Le chatbot tourne :
> `useChat` → `POST /api/chat` → `LlmClient.streamChat`, avec tool use.
> Ce cours **n'y touche pas**. Il construit, à côté du serveur, la
> première moitié d'un RAG : transformer des PDF en morceaux de texte
> vectorisés, stockés dans Postgres, et vérifier qu'on sait les retrouver.
>
> **Le fil rouge.** Un PDF de 6 pages, `guide-rh.pdf`, déposé dans
> `apps/api/data/pdfs/`. Nous le suivrons jusqu'à ce que la question
> « Combien est-ce qu'on me rembourse pour ma box quand je bosse de chez moi ? »
> retrouve le passage « Les frais de connexion sont remboursés… », alors que
> les deux phrases n'ont aucun mot en commun.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'est-ce qu'un RAG, et quelle moitié construisons-nous ? |
| 1 | Où stocker des vecteurs, et comment créer le schéma ? |
| 2 | Comment lire le texte d'un PDF sans perdre les pages ni les paragraphes ? |
| 3 | Comment nettoyer ce texte (en-têtes, césures, caractères) ? |
| 4 | Comment le découper en morceaux d'environ 500 tokens ? |
| 5 | Comment obtenir les vecteurs, de façon fiable ? |
| 6 | Comment ingérer sans doublon et sans état à moitié écrit ? |
| 7 | Comment chercher, et que fait l'opérateur `<=>` ? |
| 8 | Que se passe-t-il quand ça se passe mal ? |
| 9 | Synthèse, vérifications manuelles et corrigé |

---

## Leçon 0 : qu'est-ce qu'un RAG ?

### L'idée en une phrase

Un modèle de langage ne connaît pas tes documents. Le **RAG**
(*Retrieval-Augmented Generation*) consiste à **retrouver** les passages
pertinents de tes documents, puis à les **donner au modèle** avec la
question, pour qu'il réponde en s'appuyant dessus.

« Retrouver » est le point difficile. Une recherche par mots-clés échoue dès
que l'utilisateur ne prend pas les mêmes mots que le document : « box » et
« bosser de chez moi » contre « frais de connexion » et « télétravail ». On
compare donc le **sens**, grâce aux **embeddings** : une liste de nombres
(ici 1024) qui représente le sens d'un texte. Deux textes de sens proche ont
des vecteurs proches.

### Deux moitiés bien séparées

```
INGESTION (hors ligne, ce cours)                 INTERROGATION (en ligne, plus tard)
────────────────────────────────                 ───────────────────────────────────
PDF ─► pages ─► texte propre ─► chunks           question ─► vecteur
                                   │                            │
                                   ▼                            ▼
                          vecteurs (Voyage) ─► Postgres ◄── 5 chunks les plus proches
                                                                │
                                                                ▼
                                                     prompt + LLM ─► réponse sourcée
```

L'ingestion est un **script séparé du serveur**. Elle est lente (lecture de
PDF, appels réseau), elle ne tourne que quand les documents changent, et elle
ne doit jamais ralentir le chat. Le cours s'arrête à `npm run search`, qui
prouve que la recherche fonctionne. Brancher la recherche sur `/chat` viendra
ensuite.

### Ce que nous avons ajouté

```
chatbot/
├─ docker-compose.yml                 Postgres 17 + pgvector, port 5433
└─ apps/api/
   ├─ data/pdfs/                      les PDF (ignorés par git)
   └─ src/rag/
      ├─ config.ts                    loadDatabaseConfig(), loadEmbeddingConfig(), PDF_DIR
      ├─ document.ts                  splitPdf() : PDF → chunks, sans écriture
      ├─ db/
      │  ├─ migrations/001_init.sql   tables documents et chunks
      │  ├─ migrate.ts                exécuteur de migrations
      │  ├─ schema.ts                 vérifie la dimension de la colonne
      │  ├─ pool.ts                   connexions Postgres
      │  └─ repository.ts             toutes les requêtes SQL
      ├─ pdf/extract.ts               PDF → pages
      ├─ text/                        clean.ts, chunk.ts, tokens.ts, types.ts (fonctions pures)
      ├─ embeddings/                  types, voyage, batch, retry, factory, index
      └─ scripts/                     migrate, preview, embed-check, ingest, search
```

Une règle d'architecture traverse tout le cours. Les dossiers `text/` et
`embeddings/batch.ts` sont **purs** : ni disque, ni réseau, ni base.
`embeddings/voyage.ts` est le **seul** fichier qui connaît l'API Voyage.
`db/repository.ts` regroupe **tout** le SQL. Les scripts ne font qu'assembler
ces pièces.

> **À retenir**
> Un RAG, c'est retrouver puis générer. Ce cours construit la partie
> « retrouver » : PDF → chunks → vecteurs → Postgres → recherche par
> proximité de sens.

**Questions**
1. Pourquoi l'ingestion est-elle un script séparé, et pas une route du
   serveur appelée au démarrage ?
2. Pourquoi une recherche par mots-clés (`LIKE '%box%'`) ne suffirait-elle
   pas pour notre question fil rouge ?

---

## Leçon 1 : la base vectorielle

### Le problème

Il nous faut un endroit où stocker, pour chaque morceau de texte, son contenu,
ses pages, son document d'origine **et** un vecteur de 1024 nombres. Puis
pouvoir demander « les 5 vecteurs les plus proches de celui-ci ».

**pgvector** ajoute cela à Postgres : un type `vector(n)` et des opérateurs de
distance. On garde ainsi métadonnées et vecteurs dans la même base, avec
jointures, transactions et contraintes.

### Le code : `docker-compose.yml`

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
      POSTGRES_DB: rag
    ports:
      - "5433:5432"
    volumes:
      - rag-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rag -d rag"]
```

- L'image `pgvector/pgvector:pg17` est un Postgres 17 avec l'extension déjà
  compilée : rien à installer.
- `5433:5432` : le conteneur écoute sur 5432, ta machine sur **5433**, pour ne
  pas entrer en conflit avec un Postgres local éventuel. D'où
  `DATABASE_URL=postgres://rag:rag@localhost:5433/rag` dans le `.env`.
- Le **volume nommé** garde les données quand le conteneur s'arrête
  (`docker compose down`). Seul `down -v` les efface.
- Le `healthcheck` permet à `docker compose up -d --wait` (notre
  `npm run db:up`) de rendre la main seulement quand la base accepte les
  connexions.

### Le code : `db/migrations/001_init.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_name    text        NOT NULL UNIQUE,
    sha256       char(64)    NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id  bigint  NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    chunk_index  integer NOT NULL,
    page_start   integer NOT NULL,
    page_end     integer NOT NULL,
    content      text    NOT NULL,
    token_count  integer NOT NULL,
    embedding    vector({{EMBEDDING_DIMENSION}}) NOT NULL,

    UNIQUE (document_id, chunk_index),
    CHECK (page_start >= 1 AND page_end >= page_start),
    CHECK (token_count > 0)
);
```

Lisons-le comme un contrat.

- **Deux tables**, parce qu'un PDF donne N morceaux. Le `sha256` appartient au
  *fichier* (il servira à savoir s'il a changé, leçon 6). Le vecteur
  appartient au *morceau*.
- `file_name UNIQUE` : le nom de fichier est la clé métier. C'est par lui
  qu'on retrouve un document déjà ingéré.
- `ON DELETE CASCADE` : supprimer un document supprime ses chunks. Réingérer
  un fichier deviendra « supprimer le document, réinsérer » : impossible de
  laisser des chunks orphelins.
- `UNIQUE (document_id, chunk_index)` et les deux `CHECK` : la base refuse
  elle-même les incohérences (deux chunks n° 3, une page 0, des pages à
  l'envers). La contrainte `UNIQUE` crée aussi un index B-tree qui commence
  par `document_id` : supprimer les chunks d'un document sera rapide.
- `vector({{EMBEDDING_DIMENSION}})` : ce n'est pas du SQL valide, c'est un
  **marqueur**. La dimension dépend du modèle d'embedding (1024 pour
  voyage-3.5 par défaut, 1536 ou 512 pour d'autres). Elle ne doit donc pas
  être écrite en dur. L'exécuteur de migrations la remplace.

### Le code : `db/migrate.ts`

```ts
export async function runMigrations(pool: pg.Pool, variables: MigrationVariables): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const sql = render(await readFile(MIGRATIONS_DIR + file, "utf8"), variables);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Échec de la migration ${file}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return applied;
}
```

Trois idées dans ces lignes.

1. **La mémoire des migrations.** La table `schema_migrations` liste celles
   déjà passées. Relancer la commande ne fait rien de plus : c'est une
   première forme d'**idempotence**, une notion qui reviendra à la leçon 6.
2. **Une transaction par migration.** Postgres sait annuler un `CREATE TABLE`.
   Si la migration plante à la moitié, `ROLLBACK` ramène la base à l'état
   d'avant : jamais une table créée sur deux.
3. **`pool.connect()` plutôt que `pool.query()`.** Un pool prête une
   connexion différente à chaque `pool.query()`. Or `BEGIN`, les requêtes et
   `COMMIT` doivent passer par **la même** connexion pour former une
   transaction. On en emprunte donc une (`connect`) et on la rend
   (`release`) dans le `finally`, même en cas d'erreur.

Le remplacement du marqueur, lui, est volontairement strict :

```ts
function render(sql: string, variables: MigrationVariables): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in variables)) throw new Error(`Variable de migration inconnue : {{${name}}}`);
    return String(variables[name as keyof MigrationVariables]);
  });
}
```

Une faute de frappe (`{{EMBEDING_DIMENSION}}`) lève une erreur au lieu de
laisser un marqueur dans le SQL.

### Une dimension configurable… mais figée : `db/schema.ts`

Une fois la migration passée, la dimension est **gravée dans le type de la
colonne**. Si quelqu'un change `EMBEDDING_DIMENSION` ensuite, les insertions
échoueront au milieu d'une ingestion. On vérifie donc dès le démarrage de
chaque script :

```ts
const { rows } = await pool.query<{ type: string }>(`
  SELECT format_type(atttypid, atttypmod) AS type
  FROM pg_attribute
  WHERE attrelid = to_regclass('chunks') AND attname = 'embedding'
`);

const actual = rows[0]?.type;
if (actual === undefined) {
  throw new ConfigError("Table chunks introuvable : lance d'abord « npm run db:migrate ».");
}
if (actual !== `vector(${expected})`) {
  throw new ConfigError(/* … recréer le schéma et tout réingérer … */);
}
```

`pg_attribute` est le catalogue où Postgres décrit chaque colonne de chaque
table. `format_type` en rend le type tel qu'on l'a écrit : `vector(1024)`.
`to_regclass('chunks')` renvoie `NULL` si la table n'existe pas, au lieu de
lever une erreur, d'où le premier cas.

### La configuration : `rag/config.ts`

```ts
export function loadDatabaseConfig(): DatabaseConfig {
  loadDotEnv();
  requireEnv(["DATABASE_URL", "EMBEDDING_DIMENSION"]);
  return {
    databaseUrl: process.env["DATABASE_URL"]!.trim(),
    embeddingDimension: parseDimension(process.env["EMBEDDING_DIMENSION"]!),
  };
}
```

`loadDotEnv()` et `requireEnv()` ont été extraites de `src/config.ts`, celui
du serveur : même `.env`, mêmes messages d'erreur. Le RAG a cependant sa
**propre** fonction de configuration, et même deux :
`loadDatabaseConfig()` et `loadEmbeddingConfig()` (leçon 5). Chaque script ne
réclame que ce qu'il utilise. `db:migrate` fonctionne sans clé Voyage, et le
serveur de chat n'exige pas `DATABASE_URL`.

### Quand un index vectoriel devient-il utile ?

Nous n'avons créé **aucun** index vectoriel. Sans index, Postgres fait un
**parcours séquentiel** : il calcule la distance entre la question et
*chaque* chunk, puis trie. Le résultat est **exact**, et le coût est linéaire
(nombre de chunks × dimension).

- Jusqu'à 10 000 à 50 000 chunks environ : quelques millisecondes. Un index
  n'apporterait rien.
- Au-delà de 100 000 chunks environ, ou avec beaucoup de requêtes par
  seconde : la latence devient visible et l'index se justifie.

Les deux index de pgvector sont **approximatifs** (ANN, *Approximate Nearest
Neighbor*) : beaucoup plus rapides, mais ils peuvent manquer un voisin. La
proportion de vrais voisins retrouvés s'appelle le **rappel** (*recall*).

| Index | Principe | Pour | Contre |
| --- | --- | --- | --- |
| HNSW | graphe à plusieurs niveaux | excellent rappel, peut se créer sur une table vide | gourmand en mémoire, construction lente |
| IVFFlat | vecteurs rangés en listes (clusters) | construction rapide, compact | à créer *après* le chargement ; rappel sensible au réglage |

Un index se crée **pour un opérateur**. Celui-ci :

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

ne sert qu'aux requêtes qui trient par `<=>` (leçon 7).

> **À retenir**
> Deux tables liées par une cascade, des contraintes qui protègent la
> cohérence, une dimension qui vient de la config mais reste figée dans la
> colonne une fois migrée. Pas d'index vectoriel tant qu'on reste sous les
> 100 000 chunks environ : la recherche est exacte.

**Questions**
1. Pourquoi la migration utilise-t-elle `pool.connect()` alors que le reste du
   code se contente de `pool.query()` ?
2. Tu passes `EMBEDDING_DIMENSION` de 1024 à 512 après avoir migré. Que se
   passe-t-il au prochain `npm run ingest`, et que faut-il faire ?
3. Que perd-on en ajoutant un index HNSW ?

---

## Leçon 2 : lire un PDF

### Le problème

Un PDF n'est pas un document texte. C'est une suite d'**instructions de
dessin** : « écris "Le télétravail" en Helvetica 11 à la position (60, 762) ».
Il ne contient ni paragraphes, ni phrases, parfois même pas d'espaces entre
les mots. Il nous faut pourtant le texte, page par page (pour pouvoir citer
« page 3 »), et si possible les paragraphes (pour couper au bon endroit).

pdf.js (la bibliothèque de Firefox, utilisée via `unpdf`) nous donne, pour
chaque page, une liste de **fragments** :

```
{ str: "Phrase S1P1N1 : Le télétravail est ouvert à tous les", hasEOL: true,  transform: [11, 0, 0, 11, 60, 762] }
{ str: "salariés après la période d'essai. Phrase S1P1N2 : La",  hasEOL: true,  transform: [11, 0, 0, 11, 60, 747] }
```

`hasEOL` signale une fin de ligne. `transform[5]` est l'**ordonnée** du
fragment (en points, l'origine étant en bas de la page).

### Le code : `pdf/extract.ts`

```ts
export async function extractPages(pdfBytes: Uint8Array): Promise<Page[]> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  try {
    const pages: Page[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const { items } = await page.getTextContent();
      pages.push({ pageNumber, text: linesToText(toLines(items)) });
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
```

- `new Uint8Array(pdfBytes)` fait une **copie**. pdf.js *transfère* le
  tampon qu'on lui donne vers son worker, ce qui le vide côté appelant. Or le
  script d'ingestion a encore besoin des octets, ne serait-ce que pour le
  sha256.
- La boucle va de 1 à `numPages` : chaque `Page` garde son numéro, c'est
  ce qui permettra de dire « page 3 ».
- Le `finally` libère la mémoire et le worker de pdf.js, même si une page
  est illisible.

### Des fragments aux lignes

```ts
function toLines(items: object[]): Line[] {
  const lines: Line[] = [];
  let text = "";
  let y: number | undefined;

  for (const item of items.filter(isTextItem)) {
    if (item.str !== "") {
      y ??= item.transform[5];
      text += item.str;
    }
    if (item.hasEOL && y !== undefined) {
      lines.push({ text, y });
      text = "";
      y = undefined;
    }
  }
  if (y !== undefined) lines.push({ text, y });

  return lines;
}
```

On accumule les fragments jusqu'à un `hasEOL`. `y ??= …` retient l'ordonnée
du **premier** fragment non vide de la ligne. pdf.js émet parfois des
fragments vides qui portent seulement le `hasEOL` : on ne doit pas leur
emprunter une position.

### Des lignes aux paragraphes : l'interligne

Premier essai, avec `extractText()` d'unpdf : les titres se retrouvaient
collés au paragraphe suivant (« Télétravail Phrase S1P1N1 : … »). L'espace
vertical entre deux paragraphes ne produit **aucun caractère** : sans les
positions, il est perdu. D'où cette fonction :

```ts
const PARAGRAPH_GAP_RATIO = 1.4;

function linesToText(lines: Line[]): string {
  const gaps = lines.slice(1).map((line, i) => lines[i]!.y - line.y);
  const usualGap = median(gaps.filter((gap) => gap > 0));

  return lines
    .map((line, i) => {
      const gap = i === 0 ? 0 : lines[i - 1]!.y - line.y;
      const startsParagraph = usualGap > 0 && gap > usualGap * PARAGRAPH_GAP_RATIO;
      return (startsParagraph ? "\n" : "") + line.text;
    })
    .join("\n");
}
```

Sur notre PDF, les lignes sont espacées de 15 points. Entre deux paragraphes,
il y a une ligne blanche : 30 points. La **médiane** des écarts vaut 15, le
seuil 21. Tout écart supérieur insère un `\n` de plus, c'est-à-dire une
ligne vide, que le nettoyage interprétera comme une fin de paragraphe. On
prend la médiane, et non la moyenne, pour qu'elle ne soit pas tirée vers le
haut par les grands écarts qu'on cherche justement à détecter.

> **À retenir**
> Un PDF ne contient que des fragments positionnés. On reconstruit les lignes
> avec `hasEOL`, les paragraphes avec l'interligne, et chaque page garde son
> numéro.

**Questions**
1. Pourquoi la médiane des écarts plutôt que la moyenne ?
2. Un PDF scanné passe dans `extractPages`. Qu'obtient-on ?

---

## Leçon 3 : nettoyer le texte

### Le problème

Voici le texte brut extrait du début de la page 2 de notre fil rouge :

```
Guide RH interne — Version 2026

Page 2 / 6
support au poste 4242.

Phrase S2P3N1 : La sécurité des données impose l'usage du VPN pour toute conn-
exion au réseau interne. …
```

Trois défauts : un **en-tête** et un **pied de page** (que pdf.js a lus en
premier, dans l'ordre où le PDF les dessine), un mot **coupé par une césure**
(`conn-` / `exion`), et un découpage en lignes qui ne correspond à rien pour
le sens. Ces défauts ne sont pas cosmétiques. Un pied « Guide RH — Page 3 »
répété dans chaque chunk se retrouve dans tous les vecteurs : ils se
ressemblent alors artificiellement, et la recherche perd en précision.

Tout le fichier `text/clean.ts` est **pur** : une liste de pages en entrée,
une liste de pages en sortie.

```ts
export function cleanPages(rawPages: Page[]): CleanResult {
  const linesPerPage = rawPages.map((page) => normalizeCharacters(page.text).split("\n").map((line) => line.trim()));
  const repeated = findRepeatedMarginLines(linesPerPage);
  const removed = new Map<string, string>();

  const pages = rawPages.map((page, i) => {
    const lines = removeMarginLines(linesPerPage[i]!, repeated, removed);
    return { pageNumber: page.pageNumber, text: buildParagraphs(lines).join("\n\n") };
  });

  return { pages, removedMarginLines: [...removed.values()] };
}
```

Quatre étapes, dans l'ordre : normaliser les caractères, trouver les lignes
répétées sur **toutes** les pages, les retirer de **chaque** page, puis
regrouper les lignes en paragraphes. La deuxième étape a besoin de voir
toutes les pages à la fois : c'est pour cela que le nettoyage prend la liste
entière, et pas une page à la fois.

### Étape 1 : les caractères

```ts
export function normalizeCharacters(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKC"))
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[^\S\n]+/g, " ");
}
```

- `ﬀ-ﬆ` sont les **ligatures** typographiques (`ﬁ`, `ﬂ`, `ﬀ`…),
  fréquentes dans les PDF. Pour un tokenizer, « ﬁchier » et « fichier » sont
  deux mots différents. `normalize("NFKC")` les décompose. On ne l'applique
  qu'aux ligatures : sur tout le texte, NFKC changerait aussi « m² » en « m2 ».
- `­` est le tiret conditionnel, `​…` des caractères invisibles :
  supprimés.
- `[^\S\n]+` signifie « tout blanc sauf le retour à la ligne » : espaces
  insécables, espaces fines, tabulations deviennent une espace simple. On
  garde les `\n`, dont on a encore besoin.

### Étape 2 : les en-têtes et pieds de page

L'idée : un en-tête est une ligne qui revient **en haut ou en bas** de
**la plupart** des pages. Il faut deux outils.

```ts
function signature(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#");
}
```

« Page 2 / 6 » et « Page 3 / 6 » ne sont pas identiques, mais ont la même
**signature** : `page # / #`. C'est elle qu'on compare.

```ts
const MARGIN_LINES = 2;
const MIN_PAGES_FOR_REPEAT = 3;
const REPEAT_RATIO = 0.5;

function findRepeatedMarginLines(linesPerPage: string[][]): Set<string> {
  const pageCount = linesPerPage.length;
  if (pageCount < MIN_PAGES_FOR_REPEAT) return new Set();

  const occurrences = new Map<string, number>();
  for (const lines of linesPerPage) {
    const signatures = new Set(marginIndices(lines).map((i) => signature(lines[i]!)));
    for (const sig of signatures) occurrences.set(sig, (occurrences.get(sig) ?? 0) + 1);
  }

  const threshold = Math.max(MIN_PAGES_FOR_REPEAT, Math.ceil(pageCount * REPEAT_RATIO));
  return new Set([...occurrences].filter(([, count]) => count >= threshold).map(([sig]) => sig));
}
```

- `marginIndices(lines)` renvoie les indices des 2 premières et 2 dernières
  lignes non vides. On ne cherche **que là** : une phrase répétée au milieu
  d'une page (une définition reprise, par exemple) n'est pas un en-tête.
- Le `Set` par page fait qu'une ligne présente deux fois sur la même page ne
  compte qu'une fois.
- Seuil : au moins la moitié des pages, et au moins 3. Avec 2 pages, on ne
  peut pas distinguer un en-tête d'une coïncidence, donc on ne supprime rien.
  La moitié, et non la totalité, permet d'attraper les en-têtes alternés des
  livres (titre à gauche, chapitre à droite).

Sur le fil rouge, deux signatures passent le seuil (6 pages sur 6) :
`guide rh interne — version #` et `page # / #`.

### Étape 3 : les césures

```ts
const HYPHENATED_END = /\p{L}-$/u;
const LOWERCASE_START = /^\p{Ll}/u;

export function joinText(left: string, right: string): string {
  if (left === "") return right;
  if (right === "") return left;
  if (HYPHENATED_END.test(left) && LOWERCASE_START.test(right)) return left.slice(0, -1) + right;
  return `${left} ${right}`;
}
```

Une lettre suivie d'un tiret en fin de ligne, puis une minuscule au début de
la suivante : c'est une césure, on recolle sans le tiret
(`conn-` + `exion` → `connexion`). Sinon, on joint avec une espace. `\p{L}`
et `\p{Ll}` sont des classes Unicode (« une lettre », « une minuscule ») :
elles reconnaissent `é`, ce que `[a-z]` ne ferait pas.

Cette fonction est **exportée** : le découpage (leçon 4) en aura besoin pour
recoller une phrase coupée par un saut de page.

Limite connue : « porte-\nmonnaie » devient « portemonnaie ». Sans
dictionnaire, impossible de distinguer un vrai trait d'union d'une césure.

### Étape 4 : les paragraphes

```ts
export function buildParagraphs(lines: string[]): string[] {
  const fullLineLength = percentile(
    lines.filter((line) => line !== "").map((line) => line.length),
    0.8,
  );
  const isShort = (line: string) => line.length < fullLineLength * 0.8;

  const paragraphs: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") paragraphs.push(current);
    current = "";
  };

  lines.forEach((line, i) => {
    if (line === "") return flush();
    if (BULLET.test(line)) flush();

    current = joinText(current, line);

    const next = lines[i + 1];
    if (
      next !== undefined &&
      next !== "" &&
      isShort(line) &&
      (TERMINAL_PUNCTUATION.test(line) || UPPERCASE_START.test(next))
    ) {
      flush();
    }
  });
  flush();

  return paragraphs;
}
```

On accumule les lignes dans `current` (avec `joinText`, qui gère les césures)
et on « vide » (`flush`) dans trois cas :

1. **une ligne vide**, celle qu'a insérée l'extraction grâce à l'interligne :
   le signal le plus fiable ;
2. **une puce** (`•`, `-`, `1.`, `a)`…) : elle commence un nouvel élément ;
3. **une ligne nettement plus courte** que les lignes pleines, qui finit par
   une ponctuation forte ou est suivie d'une majuscule. C'est typiquement la
   dernière ligne d'un paragraphe, ou un titre. Le cas 3 est un filet de
   sécurité pour les PDF dont l'interligne ne trahit rien.

La « longueur d'une ligne pleine » est le **80ᵉ percentile** des longueurs de
la page, pas le maximum : une seule ligne anormalement longue (une URL) ne
doit pas faire paraître toutes les autres courtes.

Le résultat est une page faite de paragraphes séparés par `\n\n`. C'est le
format qu'attend le découpage.

> **À retenir**
> Normaliser les caractères, supprimer les lignes de marge répétées
> (comparées par signature), recoller les césures, reconstruire les
> paragraphes. Tout est pur : même entrée, même sortie.

**Questions**
1. Pourquoi remplacer les chiffres par `#` avant de comparer les lignes ?
2. Pourquoi ne pas appliquer `normalize("NFKC")` à tout le texte ?
3. Une phrase d'introduction identique ouvre chaque chapitre, au milieu de la
   page. Sera-t-elle supprimée ?

---

## Leçon 4 : découper en chunks

### Le problème

Pourquoi ne pas vectoriser chaque document entier ?

1. Un embedding a une taille **fixe**. Qu'il résume une phrase ou cinquante
   pages, il reste 1024 nombres. Plus le texte est long, plus le sens est
   « moyenné », donc flou.
2. À la recherche, on veut retrouver **le passage** qui répond, pas tout le
   document. C'est aussi ce passage, et lui seul, qu'on donnera plus tard au
   LLM.

On découpe donc en **chunks** d'environ 500 tokens : assez pour garder du
contexte, assez peu pour rester précis. Trois exigences :

- couper sur une **fin de paragraphe**, sinon sur une **fin de phrase** ;
- un **recouvrement** de 15 % entre chunks consécutifs ;
- chaque chunk **connaît ses pages**, même s'il chevauche un saut de page.

### Compter les tokens : `text/tokens.ts`

```ts
const encoding = getEncoding("cl100k_base");

export const countTokens: TokenCounter = (text) => encoding.encode(text).length;
```

`js-tiktoken` (encodage `cl100k`) n'est **pas** le tokenizer de Voyage : les
comptes diffèrent de quelques pourcents. Pour viser « environ 500 », c'est
largement suffisant, la limite du modèle étant de 32 000 tokens. Le décompte
qui fait foi pour la facturation est celui que Voyage renvoie (leçon 5).

Le type `TokenCounter` (`(text: string) => number`) est important pour la
suite : le découpage **reçoit** le compteur en paramètre au lieu de
l'importer. Il reste ainsi pur, et un test pourrait lui passer un faux
compteur (« un mot = un token ») pour vérifier les coupures à la main.

### Vue d'ensemble : `text/chunk.ts`

```ts
export function chunkPages(pages: Page[], options: ChunkOptions): Chunk[] {
  const target = options.targetTokens ?? 500;
  const overlap = Math.round(target * (options.overlapRatio ?? 0.15));
  const units = toParagraphs(pages).flatMap((p) => toUnits(p, target, options.countTokens));
  return assemble(units, target, overlap, options.countTokens);
}
```

Trois temps : les **paragraphes** du document entier, puis les **unités**
(les phrases), puis l'**assemblage** des chunks. Avec une cible de 500, le
recouvrement vaut 75 tokens.

### Temps 1 : les paragraphes, par-dessus les sauts de page

Sur le fil rouge, la page 1 se termine par « …le salarié contacte le » et la
page 2 commence par « support au poste 4242. ». C'est la même phrase. Si on
traitait les pages séparément, elle serait coupée en deux morceaux absurdes.

```ts
interface Paragraph {
  text: string;
  pageOffsets: { offset: number; pageNumber: number }[];
}

function toParagraphs(pages: Page[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const page of pages) {
    const texts = page.text.split("\n\n").filter((text) => text !== "");
    texts.forEach((text, i) => {
      const previous = paragraphs.at(-1);
      const continuesPrevious =
        i === 0 &&
        previous !== undefined &&
        !TERMINAL_PUNCTUATION.test(previous.text) &&
        LOWERCASE_START.test(text);

      if (continuesPrevious) {
        const joined = joinText(previous.text, text);
        previous.pageOffsets.push({ offset: joined.length - text.length, pageNumber: page.pageNumber });
        previous.text = joined;
      } else {
        paragraphs.push({ text, pageOffsets: [{ offset: 0, pageNumber: page.pageNumber }] });
      }
    });
  }

  return paragraphs;
}
```

- On recolle seulement le **premier** paragraphe d'une page (`i === 0`), et
  seulement si le précédent ne finit **pas** par une ponctuation forte et que
  celui-ci commence par une **minuscule**. Les deux conditions ensemble
  évitent de coller un titre de haut de page au paragraphe d'avant.
- `pageOffsets` retient **où** commence chaque page dans le texte recollé.
  Pour notre phrase : `[{ offset: 0, pageNumber: 1 }, { offset: 469, pageNumber: 2 }]`
  (les caractères 0 à 467 viennent de la page 1, le 468 est l'espace ajoutée au recollage, la suite vient de la page 2).
  C'est ce qui permettra de dater chaque phrase.

### Temps 2 : les phrases, chacune avec ses pages

```ts
const sentenceSegmenter = new Intl.Segmenter("fr", { granularity: "sentence" });

function toUnits(paragraph: Paragraph, target: number, countTokens: TokenCounter): Unit[] {
  const pageAt = (offset: number) =>
    paragraph.pageOffsets.findLast((p) => p.offset <= offset)?.pageNumber ?? paragraph.pageOffsets[0]!.pageNumber;

  const units: Unit[] = [];
  for (const { segment, index } of sentenceSegmenter.segment(paragraph.text)) {
    const text = segment.trim();
    if (text === "") continue;

    const pageStart = pageAt(index);
    const pageEnd = pageAt(index + segment.trimEnd().length - 1);
    for (const piece of splitOversized(text, target, countTokens)) {
      units.push({ text: piece, tokens: countTokens(piece), pageStart, pageEnd, endsParagraph: false });
    }
  }

  if (units.length > 0) units.at(-1)!.endsParagraph = true;
  return units;
}
```

- `Intl.Segmenter` est **intégré à Node**, sans dépendance. Il connaît les
  règles de fin de phrase de chaque langue : guillemets, points de
  suspension, la plupart des abréviations.
- Chaque segment arrive avec sa position (`index`) dans le paragraphe.
  `pageAt` cherche la **dernière** page qui commence avant cette position :
  c'est la page du caractère. La phrase « …contacte le support au poste
  4242. » commence avant l'offset 469 et finit après : `pageStart = 1`,
  `pageEnd = 2`.
- `endsParagraph` marque la dernière phrase du paragraphe. L'assemblage
  s'en servira pour préférer ces endroits-là.
- `splitOversized` est un garde-fou : une « phrase » de plus de 500 tokens
  (un tableau aplati, une liste sans ponctuation) est coupée de force entre
  deux mots. Sinon, un seul chunk dépasserait la cible indéfiniment.

### Temps 3 : l'assemblage, avec recouvrement

C'est le cœur de l'algorithme.

```ts
function assemble(units: Unit[], target: number, overlap: number, countTokens: TokenCounter): Chunk[] {
  const chunks: Chunk[] = [];
  const emit = (selected: Unit[]) => chunks.push(toChunk(chunks.length, selected, countTokens));

  let window: Unit[] = [];
  let overlapCount = 0;

  for (const unit of units) {
    while (window.length > overlapCount && sumTokens(window) + unit.tokens > target) {
      const cut = chooseCut(window, overlapCount, target);
      const emitted = window.slice(0, cut);
      emit(emitted);

      const tail = overlapTail(emitted, overlap);
      window = [...tail, ...window.slice(cut)];
      overlapCount = tail.length;
    }
    window.push(unit);
  }
  if (window.length > overlapCount) emit(window);

  return chunks;
}
```

`window` est le chunk en cours de remplissage. On y ajoute les phrases une à
une. Quand la suivante le ferait dépasser 500 tokens, on le ferme :

1. `chooseCut` décide **où** couper : on n'émet pas forcément toute la
   fenêtre (voir plus bas) ;
2. on émet le début de la fenêtre (`emitted`) ;
3. le nouveau chunk commence par `tail`, les dernières phrases du chunk émis
   (le **recouvrement**), suivies de ce qui n'a pas été émis
   (`window.slice(cut)`).

`overlapCount` compte les phrases de recouvrement en tête de fenêtre. La
condition `window.length > overlapCount` empêche de fermer un chunk qui ne
contiendrait **que** du recouvrement : on émettrait le même texte en boucle
sans jamais avancer.

```ts
const MIN_FILL_FOR_PARAGRAPH_CUT = 0.6;

function chooseCut(window: Unit[], overlapCount: number, target: number): number {
  let tokens = 0;
  let best = window.length;
  window.forEach((unit, i) => {
    tokens += unit.tokens;
    if (i >= overlapCount && unit.endsParagraph && tokens >= target * MIN_FILL_FOR_PARAGRAPH_CUT) best = i + 1;
  });
  return best;
}
```

On parcourt la fenêtre et on retient la **dernière fin de paragraphe** à
laquelle le chunk atteint au moins 60 % de la cible (300 tokens). S'il n'y en
a pas, `best` reste `window.length` : on coupe après la dernière phrase. La
préférence va donc à la fin de paragraphe, et la fin de phrase sert de
repli. Le seuil de 60 % évite l'excès inverse : couper sur une fin de
paragraphe à 80 tokens produirait un chunk minuscule.

```ts
function overlapTail(emitted: Unit[], overlap: number): Unit[] {
  const tail: Unit[] = [];
  let tokens = 0;
  for (let i = emitted.length - 1; i > 0 && tokens < overlap; i--) {
    const unit = emitted[i]!;
    if (tokens + unit.tokens > overlap * 2) break;
    tail.unshift(unit);
    tokens += unit.tokens;
  }
  return tail;
}
```

On remonte depuis la fin du chunk émis et on prend des phrases **entières**
jusqu'à atteindre 75 tokens. Deux garde-fous :

- `i > 0` : on ne reprend jamais **tout** le chunk, sinon le suivant serait
  un doublon ;
- `overlap * 2` : on n'ajoute pas une phrase qui porterait le recouvrement
  au-delà de 150 tokens. Si la dernière phrase est énorme, on accepte un
  recouvrement plus court plutôt qu'un chunk fait aux deux tiers de redite.

**Pourquoi un recouvrement ?** Sans lui, une idée à cheval sur deux chunks
est coupée en deux moitiés, et aucune ne ressort bien à la recherche. Avec
15 %, la phrase de transition est présente des deux côtés.

Enfin, `toChunk` assemble le texte et calcule les pages :

```ts
function toChunk(index: number, units: Unit[], countTokens: TokenCounter): Chunk {
  const content = units
    .map((unit, i) => (i === 0 ? "" : units[i - 1]!.endsParagraph ? "\n\n" : " ") + unit.text)
    .join("");

  return {
    index,
    pageStart: Math.min(...units.map((u) => u.pageStart)),
    pageEnd: Math.max(...units.map((u) => u.pageEnd)),
    content,
    tokenCount: countTokens(content),
  };
}
```

Les phrases d'un même paragraphe sont jointes par une espace, deux
paragraphes par une ligne vide : le chunk garde sa structure. Les pages du
chunk vont de la plus petite page de début à la plus grande page de fin de
ses phrases. `tokenCount` est **recompté** sur le texte final : la somme des
phrases diffère légèrement, à cause des espaces ajoutées.

### Tout assembler : `document.ts` et l'aperçu

```ts
export async function splitPdf(pdfBytes: Uint8Array): Promise<SplitDocument> {
  const rawPages = await extractPages(pdfBytes);
  const { pages, removedMarginLines } = cleanPages(rawPages);
  const chunks = chunkPages(pages, {
    countTokens,
    targetTokens: CHUNK_TARGET_TOKENS,
    overlapRatio: CHUNK_OVERLAP_RATIO,
  });
  return { pageCount: rawPages.length, chunks, removedMarginLines };
}
```

Cette fonction est le seul point d'entrée du pipeline, utilisée par deux
scripts : `rag:preview`, qui affiche, et `ingest`, qui écrit. Les deux voient
donc **exactement** le même découpage. Sur le fil rouge :

```
━━ Chunk #0 · p. 1 · 446 tokens ━━
Télétravail

Phrase S1P1N1 : Le télétravail est ouvert à tous les salariés… Phrase S1P1N5 : En cas d'incident…

Phrase S1P2N1 : … Phrase S1P2N5 : …

Phrase S1P3N1 : … Phrase S1P3N3 : … Phrase S1P3N4 : … Phrase S1P3N5 : …

━━ Chunk #1 · p. 1 · 386 tokens ━━
Phrase S1P3N3 : … Phrase S1P3N4 : … Phrase S1P3N5 : …          ← recouvrement : la fin du chunk #0

Phrase S1P4N1 : Un bilan annuel…
…
━━ Résumé : guide-rh.pdf ━━
Pages            : 6
Chunks           : 15
Tokens / chunk   : min 380 · moy 398 · max 501
En-têtes/pieds   :
  - « Guide RH interne — Version 2026 »
  - « Page 1 / 6 »
```

Le chunk #0 s'arrête après un paragraphe à 446 tokens : ajouter le
paragraphe suivant (~95 tokens) aurait dépassé 500. La moyenne est donc sous
500, et c'est voulu : un chunk qui parle d'un seul sujet vaut mieux qu'un
chunk plein qui en mélange deux.

### Alternatives écartées

- **Taille fixe** (tous les N caractères) : trivial, mais coupe au milieu des
  mots. Suffisant pour du texte très homogène (des logs).
- **Découpage récursif** (`RecursiveCharacterTextSplitter` de LangChain) :
  très proche du nôtre. À prendre si on utilise déjà LangChain.
- **Découpage sémantique** (couper là où le sens change entre deux phrases) :
  meilleur sur du texte sans structure, mais coûte un appel d'embedding par
  phrase.
- **Découpage par structure** (titres, sections) : excellent sur du Markdown
  ou du HTML. Un PDF n'a pas de structure fiable.
- **Outils d'analyse de mise en page** (Unstructured, Docling, LlamaParse) :
  bien meilleurs sur les tableaux, les colonnes et les scans, au prix de
  Python, d'un service externe ou de modèles lourds.

> **À retenir**
> On découpe des phrases (`Intl.Segmenter`) qu'on regroupe jusqu'à environ
> 500 tokens, en coupant de préférence sur une fin de paragraphe, avec 15 %
> de phrases reprises en tête du chunk suivant. Les pages suivent chaque
> phrase grâce aux positions mémorisées, même à travers un saut de page.

**Questions**
1. Que se passerait-il sans la condition `window.length > overlapCount` ?
2. Pourquoi `chooseCut` exige-t-il un remplissage de 60 % avant d'accepter
   une fin de paragraphe ?
3. Le chunk #2 du fil rouge est étiqueté « p. 1–2 ». D'où vient cette
   information, concrètement ?

---

## Leçon 5 : les embeddings

### Le concept

Un modèle d'embedding lit un texte et produit un vecteur. Il a été entraîné
pour que des textes de **sens** proche donnent des vecteurs proches. On mesure
la proximité par l'angle entre deux vecteurs, la **similarité cosinus** : 1
pour la même direction, 0 pour aucun rapport, en pratique entre 0,2 et 0,8
pour du texte.

Première vérification réelle, avec `npm run rag:embed-check` :

```
Question : « Combien est-ce qu'on me rembourse pour ma box quand je bosse de chez moi ? »
  0.579  Les frais de connexion internet sont remboursés à hauteur de 30 euros par mois en télétravail.
  0.435  La mutuelle d'entreprise couvre le conjoint et les enfants à charge.
  0.315  Le VPN est obligatoire pour accéder au réseau interne depuis l'extérieur.
```

### Le contrat : `embeddings/types.ts`

```ts
export interface EmbeddingClient {
  readonly dimension: number;
  embedDocuments(texts: string[], options?: EmbedOptions): Promise<EmbedDocumentsResult>;
  embedQuery(text: string, options?: EmbedOptions): Promise<number[]>;
}

export interface EmbedDocumentsResult {
  vectors: number[][];
  totalTokens: number;
}
```

C'est le même principe que `LlmClient` : une interface à nous, et un seul
fichier qui connaît le fournisseur. Deux choix méritent d'être lus de près.

**Deux méthodes, pas une.** Une question est courte et formulée comme une
demande, un passage est long et affirmatif. Voyage les traite différemment
grâce au paramètre `input_type`. Il ajoute « *Represent the query for
retrieving supporting documents:* » devant une question, et « *Represent the
document for retrieval:* » devant un passage. Les deux sont ainsi projetés
pour **se retrouver**, pas pour se ressembler. Une seule méthode `embed()`
obligerait chaque appelant à se souvenir de ce détail. Avec deux méthodes,
il est impossible de se tromper.

**`totalTokens`.** C'est le décompte de Voyage, celui qui est facturé. Notre
compteur `js-tiktoken` sert à découper, celui-ci sert à savoir ce que
l'ingestion a coûté.

**La règle d'or.** Passages et questions doivent être vectorisés par le
**même modèle**, à la **même dimension**. Deux modèles produisent des espaces
incompatibles : comparer leurs vecteurs n'a aucun sens. Changer de modèle
oblige à tout réingérer.

### La requête : `embeddings/voyage.ts`

```ts
private async post(input: string[], inputType: InputType, signal?: AbortSignal): Promise<VoyageResponse> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${this.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      model: this.model,
      input_type: inputType,
      output_dimension: this.dimension,
      truncation: false,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new EmbeddingApiError(
      `Voyage a répondu HTTP ${response.status}${detail ? ` : ${detail.slice(0, 300)}` : ""}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return (await response.json()) as VoyageResponse;
}
```

- **`fetch` plutôt que le SDK.** L'API tient en un seul endpoint. Pas de
  dépendance, et on voit exactement la requête envoyée.
- **`output_dimension`.** `EMBEDDING_DIMENSION` pilote vraiment l'API
  (256, 512, 1024 ou 2048 pour voyage-3.5), et pas seulement la colonne SQL.
- **`truncation: false`.** Par défaut, Voyage *tronque* sans rien dire un
  texte trop long : la fin du chunk serait ignorée à notre insu. On préfère
  une erreur.
- **`AbortSignal.any([signal, timeout])`.** C'est le même motif qu'au cours
  sur les outils : la requête s'arrête si l'utilisateur fait Ctrl+C **ou** si
  60 secondes passent. Sans délai maximal, une connexion bloquée figerait le
  script indéfiniment.
- **L'erreur** porte le statut HTTP et le `Retry-After` éventuel : tout ce
  qu'il faut pour décider de réessayer.

Chaque réponse est ensuite **vérifiée** avant d'être utilisée :

```ts
if (response.data.length !== input.length) {
  throw new Error(`Voyage a renvoyé ${response.data.length} vecteurs pour ${input.length} textes.`);
}
for (const { embedding } of response.data) {
  if (embedding.length !== this.dimension) {
    throw new Error(
      `Voyage a renvoyé un vecteur de dimension ${embedding.length}, EMBEDDING_DIMENSION=${this.dimension}.`,
    );
  }
}
```

Une réponse incomplète ou de mauvaise dimension est arrêtée **ici**, avec un
message clair, et non trois couches plus loin sous la forme d'une erreur SQL
obscure.

### Les lots : `embeddings/batch.ts`

Envoyer un texte par requête serait lent, et tout envoyer d'un coup
dépasserait les limites de l'API (1 000 textes et 320 000 tokens par requête
pour voyage-3.5). On regroupe :

```ts
export function planBatches(texts: string[], limits: BatchLimits, countTokens: TokenCounter): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;

  texts.forEach((text, i) => {
    const tokens = countTokens(text);
    if (current.length > 0 && (current.length >= limits.maxTexts || currentTokens + tokens > limits.maxTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(i);
    currentTokens += tokens;
  });
  if (current.length > 0) batches.push(current);

  return batches;
}
```

La fonction renvoie des **indices**, pas des textes. Pour 300 textes :
`[[0…127], [128…255], [256…299]]`. Grâce à eux, on remet chaque vecteur à sa
place :

```ts
for (const [i, indices] of batches.entries()) {
  const response = await this.request(indices.map((index) => texts[index]!), "document", options.signal);
  response.data.forEach((item) => {
    vectors[indices[item.index]!] = item.embedding;
  });
  totalTokens += response.usage.total_tokens;
  options.onBatch?.({ done: i + 1, total: batches.length });
}
```

`item.index` est la position dans le **lot**, et `indices[item.index]` la
position dans la liste **d'origine**. Le vecteur du chunk 130 atterrit en
`vectors[130]`, quel que soit l'ordre des réponses.

Les limites que nous passons sont plus basses que celles de l'API :

```ts
const MAX_TEXTS_PER_BATCH = 128;
const TOKEN_SAFETY_MARGIN = 0.8;
```

128 textes au lieu de 1 000 : un lot raté coûte moins cher à refaire, et la
progression est plus fine. 80 % de la limite de tokens : notre compteur
n'est pas celui de Voyage, on garde donc de la marge. Les lots partent **l'un
après l'autre**. C'est plus lent qu'en parallèle, mais on reste sous les
quotas par minute sans avoir à les connaître.

### Les nouvelles tentatives : `embeddings/retry.ts`

```ts
export class EmbeddingApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
```

Toutes les erreurs ne se valent pas :

- **429** : quota dépassé, trop de requêtes ou de tokens par minute. Il
  suffit d'attendre.
- **5xx** : panne passagère chez le fournisseur. Il suffit d'attendre.
- **400, 401, 403** : requête invalide ou clé refusée. Attendre ne changera
  rien : on échoue tout de suite.

```ts
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt > options.retries || !isTransient(error) || options.signal?.aborted) throw error;

      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jittered = exponential / 2 + Math.random() * (exponential / 2);
      const delayMs = Math.round(
        error instanceof EmbeddingApiError && error.retryAfterMs !== undefined
          ? Math.max(error.retryAfterMs, jittered)
          : jittered,
      );

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, undefined, { signal: options.signal });
    }
  }
}
```

Ligne par ligne :

- On abandonne si on a épuisé les tentatives, si l'erreur n'est pas
  passagère, ou si l'utilisateur a annulé.
- **Délai exponentiel** : 1 s, 2 s, 4 s, 8 s… plafonné à 30 s. Si le serveur
  est saturé, insister vite ne fait qu'aggraver les choses.
- **Jitter** : on tire le délai au hasard entre la moitié et la totalité de
  l'exponentielle. Si dix processus reçoivent un 429 à la même seconde et
  réessaient tous exactement 2 s plus tard, ils recréent le même pic. Le
  hasard étale les retours.
- **`Retry-After`** : si le serveur dit combien attendre, on attend **au
  moins** ce délai.
- `sleep(…, { signal })` : un Ctrl+C pendant l'attente l'interrompt.

`isTransient` ajoute deux erreurs qui ne sont pas des réponses HTTP : la
coupure réseau (`TypeError("fetch failed")`) et le délai dépassé
(`TimeoutError`). Toute autre `TypeError` est un bug de notre code, et la
réessayer ne servirait à rien.

**Pourquoi 8 tentatives ?** Pendant les tests, le compte Voyage (sans moyen
de paiement) était limité à **3 requêtes et 10 000 tokens par minute**. Avec
5 tentatives, les attentes cumulées (environ 25 s) ne couvraient pas une
fenêtre d'une minute, et l'ingestion échouait. Avec 8, elles dépassent deux
minutes :

```ts
const RETRY = { retries: 8, baseDelayMs: 1_000, maxDelayMs: 30_000 };
```

Testé contre un faux serveur local, le comportement est le suivant :

```
[voyage] HTTP 429 — tentative 2/9 dans 1000 ms      ← Retry-After: 1 respecté
[voyage] HTTP 503 — tentative 3/9 dans 1859 ms
lot { done: 1, total: 3 }                           ← 300 textes : lots de 128, 128 et 44
lot { done: 2, total: 3 }
lot { done: 3, total: 3 }
401 → EmbeddingApiError 401                          ← échec immédiat, un seul appel
```

### La fabrique : `embeddings/factory.ts`

```ts
export function createEmbeddingClient({ provider, apiKey, model, dimension }: EmbeddingClientOptions): EmbeddingClient {
  switch (provider) {
    case "voyage":
      return new VoyageEmbeddingClient({ apiKey, model, dimension });
    default:
      throw new Error(`Fournisseur d'embeddings inconnu : "${provider}". …`);
  }
}
```

C'est le même schéma que `createLlmClient` : `EMBEDDING_PROVIDER` choisit
l'implémentation, et le reste du code ne voit que `EmbeddingClient`. Ajouter
OpenAI ou un modèle local demanderait un fichier et un `case`. `index.ts`
n'exporte que les types et la fabrique : `VoyageEmbeddingClient` n'est pas
importable de l'extérieur du dossier.

### Alternatives écartées

- **Le SDK `voyageai`** : utile s'il apporte quelque chose de plus
  (multimodal, reranking, tokenizer exact).
- **Des lots en parallèle** : bien plus rapide sur de gros volumes, à
  condition de connaître ses quotas et de limiter la concurrence.
- **Des embeddings locaux** (bge-m3, multilingual-e5 via Ollama) : gratuits,
  et les données ne sortent pas de ta machine. C'est le bon choix quand la
  confidentialité l'exige. Qualité souvent inférieure, et lent sans GPU.
- **Des vecteurs quantifiés** (`int8`, `binary`) : 4 à 32 fois moins de
  stockage, pour une petite perte de précision.

**Note sur les modèles.** La famille **voyage-4** (`voyage-4`, `-lite`,
`-large`) a les mêmes dimensions (1024 par défaut) et les mêmes limites que
la 3.5. Pour l'essayer, il suffit de mettre `EMBEDDING_MODEL=voyage-4` : pas
de migration, mais il faut **tout réingérer** (règle d'or).

> **À retenir**
> `embedDocuments` et `embedQuery` encodent différemment (`input_type`).
> Un client fiable regroupe en lots, réessaie seulement les erreurs
> passagères (délai exponentiel, jitter, `Retry-After`), borne chaque requête
> dans le temps et vérifie chaque réponse. Même modèle, même dimension des
> deux côtés, toujours.

**Questions**
1. Pourquoi `planBatches` renvoie-t-il des indices plutôt que des listes de
   textes ?
2. Pourquoi ne pas réessayer sur une erreur 401 ?
3. À quoi sert le hasard dans le délai d'attente ?

---

## Leçon 6 : l'ingestion

### Le problème

`npm run ingest` sera lancé souvent : après chaque dépôt de PDF, ou par
réflexe. Il doit être **idempotent** : le relancer ne change rien de plus.

- Un fichier **inchangé** est ignoré : aucun appel Voyage, aucun coût.
- Un fichier **nouveau** est ingéré.
- Un fichier **modifié** est réingéré : ses anciens chunks sont supprimés,
  les nouveaux insérés.
- Si quelque chose échoue en route, la base ne doit **jamais** contenir un
  document à moitié écrit.

### Le code : `scripts/ingest.ts`

```ts
async function ingestFile(fileName: string, knownHash: string | undefined, deps: IngestDeps): Promise<Outcome> {
  const started = performance.now();
  try {
    const bytes = await readFile(path.join(PDF_DIR, fileName));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 === knownHash) {
      console.log(`= ${fileName} : inchangé, ignoré`);
      return "skipped";
    }

    // 1. Découpage (local, rapide).
    const { pageCount, chunks } = await splitPdf(bytes);

    // 2. Embeddings (réseau, lent) — avant d'ouvrir la transaction.
    const { vectors, totalTokens } = await deps.embedder.embedDocuments(
      chunks.map((chunk) => chunk.content),
      { signal: deps.signal },
    );

    // 3. Écriture (transaction courte).
    await replaceDocument(deps.pool, { fileName, sha256, chunks, embeddings: vectors });

    const verb = knownHash === undefined ? "nouveau" : "modifié, réingéré";
    console.log(
      `+ ${fileName} : ${verb} · ${pageCount} pages · ${chunks.length} chunks · ` +
        `${totalTokens} tokens d'embedding · ${seconds(started)}`,
    );
    return "ingested";
  } catch (error) {
    console.error(`✗ ${fileName} : ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
```

**L'empreinte.** `createHash("sha256")` résume le contenu en 64 caractères
hexadécimaux. Un seul octet modifié change toute l'empreinte. On la compare
à celle stockée en base (`knownHash`, lue une seule fois au démarrage par
`getDocumentHashes`). La date de modification du fichier ne conviendrait
pas : une copie la change sans changer le contenu.

**L'ordre des trois étapes est le point clé de la leçon.** Les embeddings
sont calculés **avant** d'ouvrir la transaction. Une transaction garde des
verrous et occupe une connexion. Si elle restait ouverte pendant des appels
réseau qui peuvent durer des minutes (quotas, nouvelles tentatives), elle
bloquerait les autres écritures sur ces lignes. On fait donc tout le travail
lent d'abord, puis on écrit en quelques millisecondes.

**Les logs.** Nom, pages, chunks, tokens, durée : uniquement des
métadonnées, **jamais** `chunk.content`. Les logs finissent souvent dans des
outils partagés (CI, supervision), où un document confidentiel n'a rien à
faire. Le `catch` affiche `error.message`. Les erreurs Voyage contiennent le
statut et le détail renvoyé par l'API, jamais nos textes.

**L'isolement des échecs.** Un fichier en échec renvoie `"failed"` et la
boucle continue avec le suivant. Le script termine avec le code de sortie 1
pour qu'un ordonnanceur s'en aperçoive.

### La transaction : `db/repository.ts`

```ts
export async function replaceDocument(pool: pg.Pool, doc: DocumentToStore): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM documents WHERE file_name = $1", [doc.fileName]);

    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO documents (file_name, sha256) VALUES ($1, $2) RETURNING id",
      [doc.fileName, doc.sha256],
    );
    const documentId = rows[0]!.id;

    await client.query(
      `INSERT INTO chunks (document_id, chunk_index, page_start, page_end, content, token_count, embedding)
       SELECT $1, t.chunk_index, t.page_start, t.page_end, t.content, t.token_count, t.embedding::vector
       FROM unnest($2::int[], $3::int[], $4::int[], $5::text[], $6::int[], $7::text[])
         AS t(chunk_index, page_start, page_end, content, token_count, embedding)`,
      [
        documentId,
        doc.chunks.map((c) => c.index),
        doc.chunks.map((c) => c.pageStart),
        doc.chunks.map((c) => c.pageEnd),
        doc.chunks.map((c) => c.content),
        doc.chunks.map((c) => c.tokenCount),
        doc.embeddings.map(toSqlVector),
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- **Une même fonction pour « nouveau » et « modifié ».** Si le document
  n'existe pas, le `DELETE` ne supprime rien. S'il existe, il supprime le
  document et, grâce à `ON DELETE CASCADE` (leçon 1), tous ses chunks. Pas
  de `if`, pas de cas particulier.
- **`RETURNING id`** renvoie l'identifiant généré par Postgres sans seconde
  requête. `pg` le rend sous forme de chaîne, car un `bigint` peut dépasser
  ce qu'un `number` JavaScript représente exactement.
- **`unnest`.** Chaque colonne part comme **un tableau**, et `unnest` les
  « dézippe » en lignes, comme un `zip` : le 1ᵉʳ élément de chaque tableau
  forme la 1ʳᵉ ligne, etc. Tout le document s'insère en **une** requête au
  lieu de N allers-retours.
- **Les vecteurs voyagent en texte.** `toSqlVector` produit
  `'[0.0050,0.0220,…]'`, et `::vector` le convertit côté Postgres.
- **Tout ou rien.** Si une requête échoue, `ROLLBACK` : le `DELETE` est
  annulé, l'ancienne version et ses chunks sont intacts. Pendant la
  transaction, une recherche concurrente voit l'ancienne version complète,
  jamais un mélange.

### Ce que cela donne

```
2 PDF trouvé(s) dans …/apps/api/data/pdfs/
+ guide-rh.pdf : nouveau · 6 pages · 15 chunks · 5802 tokens d'embedding · 2.0 s
…
= guide-rh.pdf : inchangé, ignoré                                   ← 2e lancement
…
+ guide-rh.pdf : modifié, réingéré · 7 pages · 17 chunks · 6554 tokens d'embedding · 1.5 s
```

En base, le document 2 (15 chunks) a été remplacé par le document 3
(17 chunks). Aucun chunk orphelin.

### Le dossier et les fichiers disparus

```ts
async function listPdfs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}
```

Les sous-dossiers sont parcourus, et le nom stocké est le chemin **relatif**
à `data/pdfs/` (`rh/guide.pdf`). Un fichier présent en base mais absent du
dossier est **signalé** (`⚠ … présent en base mais plus dans le dossier`),
pas supprimé. Supprimer des données sur une simple absence est risqué : un
dossier vidé par erreur effacerait toute la base.

### Alternatives écartées

- **Ne revectoriser que les chunks modifiés** (une empreinte par chunk) :
  économise des appels sur de gros documents peu modifiés, mais complique
  la logique. Supprimer puis réinsérer est simple et toujours correct.
- **Identifier par sha256 plutôt que par nom** : un fichier renommé ne serait
  pas réingéré, mais deux fichiers identiques se confondraient.
- **`COPY`** : le plus rapide pour des millions de lignes, plus lourd à
  mettre en place que `unnest`.
- **Un verrou consultatif** (`pg_advisory_lock`) : empêcherait deux
  ingestions simultanées de se marcher dessus. Utile avec un ordonnanceur,
  inutile pour un script lancé à la main.

> **À retenir**
> L'empreinte décide (le contenu, pas la date). Le travail lent se fait hors
> transaction, les écritures dans une transaction courte, tout ou rien. Les
> logs ne contiennent que des métadonnées.

**Questions**
1. Pourquoi les embeddings sont-ils calculés en dehors de la transaction ?
2. Pourquoi `replaceDocument` n'a-t-il pas besoin d'un `if` pour distinguer
   un document nouveau d'un document modifié ?
3. Pourquoi l'idempotence repose-t-elle sur le sha256 et non sur la date de
   modification ?

---

## Leçon 7 : la recherche

### Le code : `db/repository.ts`

```ts
export const SEARCH_SQL = `
SELECT d.file_name,
       c.chunk_index,
       c.page_start,
       c.page_end,
       c.content,
       1 - (c.embedding <=> $1::vector) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
ORDER BY c.embedding <=> $1::vector
LIMIT $2`;
```

`$1` est le vecteur de la question, obtenu par `embedQuery` (donc avec
`input_type: "query"`), et `$2` vaut 5. La requête calcule la distance entre
ce vecteur et chaque chunk, garde les 5 plus petites et les accompagne du nom
de fichier et des pages, que la jointure va chercher dans `documents`.

### Les opérateurs de distance de pgvector

| Opérateur | Distance | Formule |
| --- | --- | --- |
| `<->` | euclidienne (L2) | longueur du segment entre les deux points |
| `<=>` | **cosinus** | `1 − cos(angle)`, entre 0 et 2 |
| `<#>` | produit scalaire **négatif** | `−(a · b)` |
| `<+>` | L1 (Manhattan) | somme des écarts absolus |

Ce sont toutes des **distances** : plus c'est petit, plus c'est proche. On
trie donc toujours par ordre **croissant**. C'est pour cela que `<#>` renvoie
le produit scalaire *négatif* : un grand produit scalaire (très similaire)
devient un petit nombre, et le même `ORDER BY … ASC` fonctionne.

**Pourquoi `<=>` ?** La similarité cosinus ne regarde que l'**angle** entre
les vecteurs, pas leur longueur, et c'est la mesure pour laquelle les modèles
d'embedding sont entraînés. Le score `1 − distance` se lit directement :
proche de 1 signifie même sens.

**Les vecteurs de Voyage sont normalisés** (longueur 1 : `rag:embed-check`
affiche une norme de 1,0000). Dans ce cas, `<=>`, `<->` et `<#>` donnent
exactement le **même classement**. `<#>` est même un peu plus rapide, car il
évite une division. On garde `<=>` parce qu'il reste juste si un futur modèle
ne normalise pas, et parce que son score est lisible.

**Pourquoi trier sur l'expression et pas sur l'alias ?** `ORDER BY score DESC`
donnerait le même résultat aujourd'hui. Mais un futur index HNSW
(`vector_cosine_ops`) ne sera utilisé que si la requête trie par
`embedding <=> constante` en ordre croissant. On écrit la requête dès
maintenant sous la forme qui le permettra.

### Le script : `scripts/search.ts`

```ts
const queryVector = await embedder.embedQuery(question);
const results = await searchChunks(pool, queryVector, TOP_K);
```

Deux lignes : vectoriser la question, puis demander les 5 voisins. Le reste
du script n'est que de l'affichage, plus deux options pédagogiques : `--sql`
affiche la requête, `--explain` montre comment Postgres l'exécute.

```ts
const { rows } = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE ${SEARCH_SQL}`, [
  toSqlVector(queryVector),
  TOP_K,
]);
for (const row of rows) console.log(`  ${row["QUERY PLAN"].replace(/'\[[^\]]*\]'/g, "'[…]'")}`);
```

Le plan recopie le vecteur littéral, soit 1 024 nombres, d'où le `replace`
qui l'abrège. Voici le résultat :

```
Limit
  ->  Sort   Sort Key: ((c.embedding <=> '[…]'::vector))   Sort Method: top-N heapsort
        ->  Hash Join
              ->  Seq Scan on chunks c          ← la distance est calculée pour chaque chunk
              ->  Seq Scan on documents d
Execution Time: 0.772 ms
```

C'est le parcours exact de la leçon 1, mot pour mot. `top-N heapsort`
indique que Postgres ne trie pas tout : il garde seulement les 5 meilleurs
dans un tas. Avec un index HNSW, le `Seq Scan on chunks` serait remplacé par
un `Index Scan using … hnsw`.

### Lire les scores

Les scores absolus dépendent du modèle. Avec voyage-3.5, un passage pertinent
tourne souvent autour de 0,5 à 0,7. Ce qui compte, c'est le **classement** et
l'**écart** entre les résultats. Sur le fil rouge, document très répétitif
(les mêmes phrases reviennent dans chaque section), les cinq premiers scores
sont presque égaux (0,609 → 0,598) : le modèle ne peut pas départager des
passages qui disent la même chose.

> **À retenir**
> `<=>` est la distance cosinus, on trie par distance croissante, et le
> score vaut `1 − distance`. Avec des vecteurs normalisés, cosinus, L2 et
> produit scalaire donnent le même classement. Sans index, c'est un
> `Seq Scan` exact.

**Questions**
1. Pourquoi `<#>` renvoie-t-il un produit scalaire **négatif** ?
2. Pourquoi la question est-elle vectorisée avec `embedQuery` et non
   `embedDocuments` ?
3. `ORDER BY score DESC` donnerait les mêmes résultats. Pourquoi ne pas
   l'écrire ainsi ?

---

## Leçon 8 : quand ça se passe mal

Reprenons chaque cas, du plus bénin au plus sérieux.

**Le PDF est scanné.** `extractPages` rend des pages vides, et le découpage
ne produit aucun chunk. L'ingestion avertit (`⚠ … aucun texte extrait (PDF
scanné ?)`) et enregistre le document sans chunk. Il ne sera pas retraité
tant qu'il ne change pas.

**Le quota Voyage est dépassé (429).** `withRetry` attend, en respectant
`Retry-After`, puis réessaie jusqu'à 8 fois. Le terminal affiche
`[voyage] HTTP 429 — tentative 2/9 dans 1000 ms`. Si le quota se libère, rien
d'autre ne se voit.

**Le quota reste dépassé.** C'est arrivé pendant les tests. Le fichier modifié
est marqué `✗ … HTTP 429`, et les suivants sont traités quand même. En base :
toujours l'**ancien** sha256 et ses 15 chunks, aucun orphelin, puisque
l'échec s'est produit **avant** la transaction. Au lancement suivant, le
sha256 diffère toujours, donc le fichier est retenté. Il l'a été, avec
succès, une minute plus tard.

**La clé est refusée (401).** Un seul appel, aucune nouvelle tentative, et
le message de Voyage s'affiche. Il n'y a rien à attendre.

**La dimension ne correspond pas.** Deux filets. Au démarrage,
`assertEmbeddingDimension` compare la colonne (`vector(1024)`) à la config.
À chaque réponse, `voyage.ts` compare la longueur des vecteurs à
`dimension`. Dans les deux cas, on s'arrête avant d'écrire quoi que ce soit.

**L'écriture échoue en pleine transaction** (base arrêtée, contrainte violée).
`ROLLBACK` : le `DELETE` est annulé, l'ancienne version revient intacte.

**Ctrl+C pendant l'ingestion.** Le `SIGINT` déclenche
l'`AbortController`. L'appel Voyage en cours est annulé (le signal est
combiné au délai de 60 s), une attente de nouvelle tentative aussi, et la
boucle s'arrête avant le fichier suivant. Un fichier interrompu avant sa
transaction n'a rien écrit.

Remarque la hiérarchie. Les erreurs passagères sont **absorbées** par les
nouvelles tentatives. Les erreurs d'un fichier sont **isolées** : les autres
continuent. Les incohérences de configuration **arrêtent tout**, avant la
moindre écriture. Et quoi qu'il arrive, la transaction garantit qu'un
document est en base dans son ancienne version complète, ou dans sa
nouvelle version complète, jamais entre les deux.

> **À retenir**
> Réessayer ce qui est passager, isoler ce qui est propre à un fichier,
> arrêter tout ce qui est incohérent. La transaction garantit qu'aucun
> document n'est jamais à moitié écrit.

**Questions**
1. Pourquoi un échec 429 sur un fichier modifié ne laisse-t-il aucune trace
   en base ?
2. Le document scanné est enregistré sans chunk. Pourquoi l'enregistrer
   plutôt que de l'ignorer ?

---

## Leçon 9 : synthèse

### Le voyage complet de `guide-rh.pdf`

| # | Où | Quoi | Fichier |
| --- | --- | --- | --- |
| 1 | script | liste `data/pdfs/`, lit les empreintes en base | `scripts/ingest.ts`, `db/repository.ts` |
| 2 | script | sha256 du fichier ≠ base : à ingérer | `scripts/ingest.ts` |
| 3 | pdf | fragments → lignes (`hasEOL`) → paragraphes (interligne), 6 pages numérotées | `pdf/extract.ts` |
| 4 | text | ligatures, espaces ; en-tête « Guide RH… » et pied « Page # / # » supprimés ; 8 césures recollées | `text/clean.ts` |
| 5 | text | paragraphes recollés à travers les pages, phrases avec leurs pages, 15 chunks de ~400 tokens avec 15 % de recouvrement | `text/chunk.ts` |
| 6 | embeddings | 1 lot de 15 textes, `input_type: "document"`, 1024 dimensions vérifiées, 5 802 tokens facturés | `embeddings/voyage.ts`, `batch.ts`, `retry.ts` |
| 7 | db | `BEGIN` → `DELETE` → `INSERT documents` → `INSERT chunks … unnest` → `COMMIT` | `db/repository.ts` |
| 8 | script | log « + guide-rh.pdf : nouveau · 6 pages · 15 chunks · … » | `scripts/ingest.ts` |
| 9 | recherche | question → `embedQuery` (`input_type: "query"`) → `ORDER BY embedding <=> $1 LIMIT 5` | `scripts/search.ts`, `db/repository.ts` |

### Les six idées à emporter

1. **Retrouver, c'est comparer des sens.** Des vecteurs proches signifient
   des textes de sens proche, même sans mot commun.
2. **Le découpage fait la qualité.** On nettoie avant de découper, on coupe
   sur des frontières de sens, avec un recouvrement, et chaque chunk garde
   ses pages.
3. **Le pur d'un côté, les effets de bord de l'autre.** `text/` et
   `batch.ts` sont testables sans réseau ni base, et `rag:preview` le montre.
4. **Un fournisseur, un fichier.** `EmbeddingClient` et sa fabrique, comme
   `LlmClient`. Même modèle et même dimension des deux côtés, toujours.
5. **Fiabilité réseau.** Des lots, des nouvelles tentatives réservées aux
   erreurs passagères, un délai maximal, une vérification de chaque réponse.
6. **Idempotence et atomicité.** Le contenu décide (sha256), le travail lent
   se fait hors transaction, les écritures se font tout ou rien.

### Vérifications manuelles

Lance chaque commande depuis `chatbot/` et compare avec ce que tu dois voir.

| Commande | Tu dois voir |
| --- | --- |
| `npm run db:up` | `Container chatbot-postgres-1 Healthy` |
| `npm run db:migrate` (1ʳᵉ fois) | `Migration appliquée : 001_init.sql`, `vector(1024) ✔` |
| `npm run db:migrate` (2ᵉ fois) | `Schéma déjà à jour` |
| `npm run rag:preview -- mon.pdf --short` | chunks avec pages et tokens, résumé : tokens min/moy/max, en-têtes détectés |
| `npm run rag:embed-check` | dimension 1024, norme ≈ 1,0000, le passage sur les frais de connexion en tête |
| `npm run ingest` (1ʳᵉ fois) | `+ mon.pdf : nouveau · N pages · M chunks · …` |
| `npm run ingest` (2ᵉ fois) | `= mon.pdf : inchangé, ignoré` |
| modifier `mon.pdf`, puis `npm run ingest` | `+ mon.pdf : modifié, réingéré` |
| `npm run search -- "ta question" --sql --explain` | 5 résultats avec fichier, pages, score ; la requête ; un `Seq Scan on chunks` |
| `EMBEDDING_API_KEY=x npm run rag:embed-check -w apps/api` | `HTTP 401` immédiat, sans nouvelle tentative |

Commandes utiles :

```bash
# Le contenu de la base
docker compose exec postgres psql -U rag -d rag -c \
  "select file_name, left(sha256, 12), ingested_at,
          (select count(*) from chunks c where c.document_id = d.id) as chunks
   from documents d"

# Aucun chunk orphelin (doit afficher 0)
docker compose exec postgres psql -U rag -d rag -c \
  "select count(*) from chunks where document_id not in (select id from documents)"

# Une distance cosinus calculée à la main
docker compose exec postgres psql -U rag -d rag -c \
  "select '[1,2,3]'::vector <=> '[1,2,4]'::vector"

# Le contenu des documents n'apparaît pas dans les logs
npm run ingest > ingest.log 2>&1; grep -c "Phrase" ingest.log   # doit afficher 0
```

### Pour aller plus loin (non fait, volontairement)

- **Brancher la recherche sur `/chat`**, sous forme d'outil
  (`search_documents`) dans le registre, ou par injection systématique des
  chunks dans le prompt.
- **Afficher les sources** : le fichier et les pages sont déjà en base, il
  reste à les faire remonter jusqu'au navigateur.
- **Recherche hybride** : combiner les vecteurs et la recherche plein texte
  de Postgres (`tsvector`) pour les noms propres et les codes exacts.
- **Reranking** : un second modèle réordonne les 20 premiers résultats.
- **Droits d'accès** : filtrer les chunks selon l'utilisateur, avant le
  classement.
- **Un index HNSW**, le jour où le volume le justifie.

---

## Corrigé des questions

> Essaie d'abord, compare ensuite.

### Leçon 0

**1. Pourquoi un script séparé ?** L'ingestion est lente (lecture de PDF,
appels réseau soumis à des quotas) et ne doit tourner que quand les documents
changent. Dans le serveur, elle ralentirait le démarrage, consommerait des
ressources pendant que des utilisateurs chattent, et se relancerait à chaque
redémarrage. Séparée, elle se lance à la main ou par un ordonnanceur, et
son échec n'empêche pas le chat de fonctionner.

**2. Pourquoi pas `LIKE '%box%'` ?** Parce que le passage pertinent ne
contient ni « box », ni « bosser », ni « chez moi ». Il parle de « frais de
connexion » et de « télétravail ». Une recherche par mots-clés ne trouve que
les textes qui partagent les mêmes mots. Les embeddings comparent le sens.

### Leçon 1

**1. Pourquoi `pool.connect()` ?** Un pool prête une connexion potentiellement
différente à chaque `pool.query()`. Une transaction est liée à **une**
connexion : `BEGIN`, les requêtes et `COMMIT` doivent toutes passer par elle.
On l'emprunte avec `connect()` et on la rend avec `release()` dans un
`finally`, sinon le pool finirait à court de connexions.

**2. De 1024 à 512 après migration ?** `assertEmbeddingDimension` arrête le
script dès le démarrage : la colonne est `vector(1024)`, la config dit 512.
Il faut recréer le schéma (`docker compose down -v`, `npm run db:up`,
`npm run db:migrate`) et tout réingérer. Les anciens vecteurs ne seraient de
toute façon pas comparables aux nouveaux.

**3. Que perd-on avec HNSW ?** L'exactitude. L'index est approximatif : il
peut manquer quelques vrais voisins (le rappel passe sous 100 %). Il coûte
aussi de la mémoire, et du temps à la construction et à chaque insertion. En
échange, la recherche ne parcourt plus toute la table.

### Leçon 2

**1. Pourquoi la médiane ?** On cherche justement les écarts anormalement
grands. Ils tireraient la moyenne vers le haut, donc le seuil aussi, et
certains changements de paragraphe passeraient inaperçus. La médiane est
insensible à ces valeurs extrêmes : elle reflète l'interligne « normal ».

**2. Un PDF scanné ?** Des pages vides. Un scan ne contient que des images :
aucun fragment de texte, rien que pdf.js puisse lire. Il faudrait une étape
d'OCR (reconnaissance de caractères) avant l'extraction.

### Leçon 3

**1. Pourquoi `#` à la place des chiffres ?** Pour que « Page 2 / 6 » et
« Page 3 / 6 » soient reconnues comme la même ligne. Sans cela, chaque numéro
de page serait unique, n'atteindrait jamais le seuil de répétition, et
resterait dans le texte.

**2. Pourquoi pas NFKC partout ?** NFKC ne se limite pas aux ligatures : il
remplace aussi les caractères de « compatibilité ». « m² » devient « m2 »,
« ½ » devient « 1⁄2 », « … » devient « ... ». Certaines de ces
transformations changent le sens. On ne l'applique qu'à la plage des
ligatures, où l'effet est exactement celui qu'on veut.

**3. Une phrase répétée au milieu des pages ?** Non. On ne cherche les
répétitions que dans les 2 premières et 2 dernières lignes non vides de
chaque page. Une phrase en milieu de page n'est jamais candidate, même si
elle revient partout.

### Leçon 4

**1. Sans `window.length > overlapCount` ?** Après une coupure, la fenêtre ne
contient parfois que le recouvrement. Si la phrase suivante est longue, le
total dépasse encore 500 : on fermerait un chunk fait **uniquement** de
recouvrement, puis on recalculerait un recouvrement à partir de lui, et ainsi
de suite. On émettrait le même texte en boucle sans jamais consommer la
phrase suivante. La condition impose qu'un chunk contienne au moins une
phrase nouvelle.

**2. Pourquoi 60 % avant une fin de paragraphe ?** Sans seuil, le premier
paragraphe court (un titre, une phrase d'introduction) déclencherait une
coupure : on obtiendrait des chunks de quelques dizaines de tokens, trop
pauvres pour être bien retrouvés. Le seuil garantit des chunks
raisonnablement remplis, tout en préférant les frontières de paragraphe.

**3. D'où vient « p. 1–2 » ?** La dernière phrase de la page 1 se termine
sur la page 2. `toParagraphs` a recollé les deux morceaux et noté dans
`pageOffsets` l'offset où commence la page 2. `toUnits` a calculé
`pageAt(début de phrase) = 1` et `pageAt(fin de phrase) = 2`. Enfin,
`toChunk` prend le minimum des `pageStart` et le maximum des `pageEnd` des
phrases du chunk.

### Leçon 5

**1. Pourquoi des indices ?** Pour remettre chaque vecteur à sa place. Les
réponses de Voyage sont numérotées dans le **lot** (`item.index`), et
`indices[item.index]` donne la position dans la liste **d'origine**. Avec des
listes de textes, il faudrait recalculer les décalages de chaque lot, ou
espérer que tout arrive dans l'ordre.

**2. Pourquoi pas de nouvelle tentative sur 401 ?** Une clé refusée ne
deviendra pas valide en attendant. Réessayer ne ferait que retarder l'erreur
de plusieurs minutes (8 tentatives et leurs délais) et cacher la vraie cause.
On ne réessaie que ce qui peut se résoudre seul : quota, panne passagère,
réseau.

**3. À quoi sert le hasard ?** À désynchroniser les clients. Si plusieurs
processus reçoivent un 429 au même instant et attendent tous exactement le
même délai, ils reviennent ensemble et recréent le pic qui a causé le refus.
Un délai tiré au hasard étale leurs retours.

### Leçon 6

**1. Pourquoi les embeddings hors transaction ?** Une transaction garde des
verrous et monopolise une connexion. Les appels Voyage peuvent durer des
minutes (quotas, nouvelles tentatives). On fait donc le travail lent d'abord,
puis une écriture de quelques millisecondes. Bonus : si Voyage échoue, la
transaction n'a même pas commencé.

**2. Pourquoi pas de `if` ?** Parce que `DELETE … WHERE file_name = $1` ne
fait simplement rien si le document n'existe pas. Le même enchaînement
`DELETE` + `INSERT` couvre les deux cas, et la cascade se charge des anciens
chunks.

**3. Pourquoi le sha256 plutôt que la date ?** La date change sans que le
contenu change (copie, `touch`, synchronisation), ce qui coûterait une
réingestion inutile. Elle peut aussi ne pas changer alors que le contenu a
changé (archive restaurée avec ses dates d'origine), et la modification
serait manquée. L'empreinte ne dépend que du contenu.

### Leçon 7

**1. Pourquoi un produit scalaire négatif ?** Pour que tous les opérateurs
soient des distances, à trier en ordre croissant. Un grand produit scalaire
signifie « très similaire ». En le rendant négatif, il devient le plus petit
nombre, et le même `ORDER BY … ASC` (le seul qu'un index sait servir)
fonctionne.

**2. Pourquoi `embedQuery` ?** Il envoie `input_type: "query"`, et Voyage
encode alors le texte comme une question qui cherche ses passages. Avec
`embedDocuments`, la question serait encodée comme un passage. Elle
retrouverait plutôt des textes qui lui *ressemblent* (d'autres questions)
que des textes qui y *répondent*.

**3. Pourquoi pas `ORDER BY score DESC` ?** Le résultat serait identique
aujourd'hui. Mais un index HNSW `vector_cosine_ops` n'est utilisé que pour
un tri de la forme `embedding <=> constante` en ordre croissant. Écrire la
requête ainsi dès maintenant évite de la réécrire le jour où l'index arrive,
et de se demander pourquoi il n'est pas utilisé.

### Leçon 8

**1. Pourquoi un 429 ne laisse-t-il aucune trace ?** L'erreur survient
pendant `embedDocuments`, à l'étape 2, avant `replaceDocument`. La
transaction n'a jamais été ouverte, et l'ancienne version n'a jamais été
touchée. Comme le sha256 en base reste l'ancien, le fichier sera retenté au
prochain lancement.

**2. Pourquoi enregistrer un document sans chunk ?** Pour l'idempotence.
S'il n'était pas enregistré, il n'aurait pas d'empreinte en base, et chaque
`npm run ingest` le retraiterait : extraction, avertissement, encore et
encore. Enregistré, il est ignoré tant qu'il ne change pas. Et s'il est
remplacé par une version contenant du texte, son sha256 changera et il sera
réingéré.
