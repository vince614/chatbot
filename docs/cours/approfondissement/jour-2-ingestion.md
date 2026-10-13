# Approfondissement · Jour 2 · Cours 1 — Le code de l'ingestion

> [← Retour au cours](../jour-2-ingestion.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

## Carte des fichiers

Les chemins `src/rag/…` sont relatifs à `apps/api/`.

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `docker-compose.yml` | Postgres 17 + pgvector sur le port 5433 | 1 |
| `src/rag/config.ts` | lit `DATABASE_URL`, `EMBEDDING_*`, définit `PDF_DIR` | 1, 6 |
| `src/rag/db/migrations/001_init.sql` | tables `documents` et `chunks` | 1 |
| `src/rag/db/migrate.ts` | applique les migrations, remplace `{{EMBEDDING_DIMENSION}}` | 1 |
| `src/rag/db/schema.ts`, `pool.ts` | vérifie la dimension de la colonne, crée le pool | 1, 9 |
| `src/rag/db/repository.ts` | tout le SQL : empreintes, écriture, recherche | 7, 8 |
| `src/rag/pdf/extract.ts` | PDF → texte page par page, avec paragraphes | 3 |
| `src/rag/text/types.ts`, `tokens.ts` | types partagés, compteur de tokens | 5 |
| `src/rag/text/clean.ts` | caractères, en-têtes/pieds, césures, paragraphes | 4 |
| `src/rag/text/chunk.ts` | découpage en chunks avec recouvrement | 5 |
| `src/rag/document.ts` | enchaîne extraction, nettoyage, découpage | 3 à 5 |
| `src/rag/embeddings/types.ts`, `factory.ts`, `index.ts` | contrat et choix du fournisseur | 6 |
| `src/rag/embeddings/batch.ts` | répartit les textes en lots | 6 |
| `src/rag/embeddings/retry.ts` | erreur typée et nouvelles tentatives | 6, 9 |
| `src/rag/embeddings/voyage.ts` | le seul fichier qui parle à l'API Voyage | 6 |
| `src/rag/scripts/ingest.ts` | `npm run ingest` | 7 |
| `src/rag/scripts/migrate.ts`, `preview.ts`, `embed-check.ts`, `search.ts` | les autres commandes | 1, 5, 6, 8 |

## Le parcours dans le code

De `npm run ingest` à la ligne en base :

1. Le `package.json` racine délègue à `apps/api`, qui lance
   `tsx src/rag/scripts/ingest.ts`.
2. `main()` (`scripts/ingest.ts`) lit la config (`loadDatabaseConfig`,
   `loadEmbeddingConfig` dans `config.ts`), crée le client
   (`createEmbeddingClient`, `embeddings/factory.ts`) et le pool
   (`createPool`, `db/pool.ts`).
3. `assertEmbeddingDimension()` (`db/schema.ts`) vérifie la colonne
   `chunks.embedding`.
4. `listPdfs(PDF_DIR)` liste les fichiers, `getDocumentHashes()`
   (`db/repository.ts`) charge les empreintes connues.
5. Pour chaque fichier, `ingestFile()` calcule le sha256 ; s'il est connu, on
   passe au suivant.
6. Sinon `splitPdf()` (`document.ts`) enchaîne `extractPages()`
   (`pdf/extract.ts`), `cleanPages()` (`text/clean.ts`) et `chunkPages()`
   (`text/chunk.ts`).
7. `embedDocuments()` (`embeddings/voyage.ts`) découpe en lots avec
   `planBatches()` puis appelle `request()` → `withRetry()` → `post()`.
8. `replaceDocument()` (`db/repository.ts`) écrit document et chunks dans une
   transaction (`INSERT … SELECT FROM unnest(…)`) ; `main()` fait le bilan.

---

## `docker-compose.yml`

Démarre la base vectorielle locale. L'image `pgvector/pgvector:pg17` contient
Postgres 17 avec l'extension `vector` déjà compilée. Les variables
`POSTGRES_USER`, `POSTGRES_PASSWORD` et `POSTGRES_DB` valent toutes `rag`.
`"5433:5432"` publie le port interne 5432 sur le 5433 de ta machine (pour ne
pas gêner un Postgres local). Le volume `rag-data` garde les données entre
deux démarrages, et le `healthcheck` interroge `pg_isready` toutes les 2 s.
`npm run db:up` lance `docker compose up -d --wait` : le `--wait` attend ce
healthcheck, donc la commande ne rend la main qu'une fois la base prête.

---

## `apps/api/src/rag/config.ts`

Lit les variables du RAG, séparément de celles du serveur de chat.

```ts
export const PDF_DIR = fileURLToPath(new URL("../../data/pdfs/", import.meta.url));
// …
export function loadDatabaseConfig(): DatabaseConfig {
  loadDotEnv();
  requireEnv(["DATABASE_URL", "EMBEDDING_DIMENSION"]);

  return {
    databaseUrl: process.env["DATABASE_URL"]!.trim(),
    embeddingDimension: parseDimension(process.env["EMBEDDING_DIMENSION"]!),
  };
}
```

**Ce que fait le code**, dans l'ordre du code :
1. `PDF_DIR` part de l'URL du fichier (`import.meta.url`), remonte de deux
   dossiers et descend dans `data/pdfs/` ; `fileURLToPath` en fait un chemin.
2. `loadDotEnv()` charge `apps/api/.env` s'il existe ; `requireEnv()` lève une
   `ConfigError` listant toutes les variables manquantes d'un coup.
3. `parseDimension()` convertit avec `Number()` et refuse tout ce qui n'est
   pas un entier entre 1 et 16 000 (la limite du type `vector`).

`loadEmbeddingConfig()` suit le même schéma avec `EMBEDDING_PROVIDER`,
`EMBEDDING_API_KEY`, `EMBEDDING_MODEL` et `EMBEDDING_DIMENSION`.

**Pourquoi c'est écrit ainsi** : deux fonctions, pour que chaque script ne
réclame que ce qu'il utilise (`db:migrate` n'a pas besoin de clé Voyage).

---

## `apps/api/src/rag/db/` : migration, schéma, pool

Le SQL de `001_init.sql` est dans le cours (leçon 1). Ce qu'il faut y voir
côté code : `GENERATED ALWAYS AS IDENTITY` numérote les lignes ;
`UNIQUE (document_id, chunk_index)` crée aussi un index B-tree utile au
`DELETE` en cascade ; les `CHECK` font échouer l'insertion (donc annuler la
transaction) si `chunk.ts` produisait une page 0 ou un chunk vide.

### `runMigrations()` (`db/migrate.ts`)

```ts
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
```

**Ce que fait le code**, dans l'ordre du code :
1. Avant la boucle : `CREATE TABLE IF NOT EXISTS schema_migrations`, lecture
   des noms déjà appliqués dans un `Set`, liste triée des `.sql` du dossier
   (le préfixe `001_` fixe l'ordre).
2. Un fichier déjà appliqué est sauté.
3. `render()` remplace les marqueurs, puis on emprunte **une** connexion.
4. `BEGIN`, le SQL, l'inscription dans `schema_migrations`, `COMMIT`.
5. Erreur : `ROLLBACK` et une nouvelle erreur qui garde l'originale en
   `cause`. `finally` rend la connexion dans tous les cas.

**Pourquoi c'est écrit ainsi** :
- Une transaction vit sur une connexion ; `pool.query()` pourrait en prendre
  une différente à chaque appel.
- L'inscription est dans la transaction : migration faite **et** notée, ou ni
  l'un ni l'autre.

### `render()` (`db/migrate.ts`)

`sql.replace(/\{\{(\w+)\}\}/g, …)` capture le nom entre `{{` et `}}` ; la fonction renvoie sa
valeur ou lève une erreur. Une faute de frappe échoue ici, avant Postgres.

### `assertEmbeddingDimension()` (`db/schema.ts`)

La fonction interroge le catalogue, sans toucher aux données :
1. `pg_attribute` est le catalogue des colonnes ; `to_regclass('chunks')`
   vaut `NULL` si la table n'existe pas, et la requête ne renvoie rien.
2. `format_type` rend le type complet, dimension comprise : `vector(1024)`.
3. Aucune ligne : migration pas faite. Type différent : `ConfigError` qui
   explique comment recréer le schéma.

`migrate`, `ingest` et `search` l'appellent au démarrage : un changement de
dimension s'arrête avant tout appel payant. `pool.ts` crée simplement un
`new pg.Pool({ connectionString: databaseUrl, max: 4 })` ; chaque script le
ferme avec `pool.end()` dans un `finally`, sinon Node ne s'arrête pas.

---

## `apps/api/src/rag/pdf/extract.ts`

Transforme les octets d'un PDF en pages `{ pageNumber, text }`.

### `extractPages()`

```ts
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
    // Libère la mémoire et le worker pdf.js associés à ce document.
    await pdf.loadingTask.destroy();
  }
```

**Ce que fait le code**, dans l'ordre du code :
1. `getDocumentProxy` (de `unpdf`, qui embarque pdf.js) ouvre le document sur
   une **copie** des octets : pdf.js peut transférer le buffer reçu, ce qui le
   viderait pour l'appelant.
2. On parcourt les pages de 1 à `numPages` : ce numéro finira dans
   `page_start` / `page_end`.
3. `getTextContent()` donne les fragments ; `toLines` puis `linesToText` en
   font un texte.
4. `cleanup()` libère la page ; le `finally` détruit le document, même en cas
   d'erreur.

### `toLines()`

Une boucle sur les fragments, avec une ligne en cours (`text`, `y`) :
1. `isTextItem` écarte les éléments sans `str` (pdf.js mêle aux fragments des
   marqueurs de contenu).
2. Un fragment non vide s'ajoute à la ligne en cours. `y ??=` ne retient que
   l'ordonnée du **premier** fragment ; `transform[5]` est la composante
   verticale de la matrice de position.
3. `hasEOL` ferme la ligne. `y !== undefined` évite d'enregistrer une ligne
   sans texte.
4. Après la boucle, une dernière ligne sans `hasEOL` est enregistrée.

### `linesToText()` et `median()`

Le code est dans le cours (leçon 3). Pas à pas :
1. `gaps` : pour chaque ligne à partir de la deuxième, `y` de la précédente
   moins `y` de la ligne. L'origine étant en bas de page, ces écarts sont
   positifs quand on descend.
2. `usualGap` : médiane des écarts **positifs** seulement (un écart négatif
   signale un retour vers le haut, par exemple une nouvelle colonne).
3. Une ligne dont l'écart dépasse `usualGap * 1.4` est précédée de `"\n"` ;
   avec la jointure par `"\n"`, cela fait une ligne vide.
4. `usualGap > 0` protège une page d'une seule ligne.
5. `median` trie une **copie** (`[...values]`) et prend l'élément du milieu
   (celui du haut pour un nombre pair). Liste vide : 0.

---

## `apps/api/src/rag/text/types.ts` et `tokens.ts`

`types.ts` définit `Page` (`pageNumber`, `text`), `Chunk` (`index`,
`pageStart`, `pageEnd`, `content`, `tokenCount`) et `TokenCounter`, le type
`(text: string) => number`. `tokens.ts` crée **une fois** l'encodage
`cl100k_base` de `js-tiktoken`, et `countTokens` renvoie
`encoding.encode(text).length`. Ce n'est pas le tokenizer de Voyage : les
comptes diffèrent un peu, ce qui suffit pour viser « environ 500 ».
`chunk.ts` reçoit ce compteur en paramètre au lieu de l'importer : un test
peut lui passer `(t) => t.split(" ").length`.

---

## `apps/api/src/rag/text/clean.ts`

Texte brut de chaque page → paragraphes séparés par `"\n\n"`. Tout est pur.

### `cleanPages()`

La fonction d'entrée, en deux passes :
1. Chaque page est normalisée, coupée en lignes, chaque ligne `trim()`ée.
2. `findRepeatedMarginLines` regarde **toutes** les pages à la fois.
3. Page par page : suppression des lignes répétées, regroupement en
   paragraphes, jointure par `"\n\n"`, numéro de page conservé.
4. `removed` garde un exemple par signature supprimée, renvoyé dans
   `removedMarginLines` pour `rag:preview`.

### `normalizeCharacters()`

```ts
export function normalizeCharacters(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKC"))
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[^\S\n]+/g, " ");
}
```

**Ce que fait le code**, dans l'ordre du code :
1. Fins de ligne `\r\n` ou `\r` → `\n`.
2. La plage `ﬀ-ﬆ` couvre les ligatures (ﬀ, ﬁ, ﬂ, ﬃ, ﬄ, ﬅ, ﬆ) : chacune est
   décomposée par `normalize("NFKC")`, appliqué à elle seule.
3. Le tiret conditionnel (U+00AD) et les caractères invisibles (U+200B à
   U+200D, U+2060, U+FEFF) sont supprimés. Ils sont écrits tels quels dans la
   source, d'où une classe qui paraît presque vide.
4. `[^\S\n]+` : « des blancs qui ne sont pas `\n` ». Insécables, espaces fines
   et tabulations deviennent une espace ; les sauts de ligne restent.

### `signature()`, `marginIndices()`, `findRepeatedMarginLines()`

Trois petites fonctions qui travaillent ensemble :
1. `signature` (dans le cours) met en minuscules et remplace les nombres par
   `#`.
2. `marginIndices` liste les indices des lignes non vides (`flatMap` qui
   renvoie `[]` ou `[i]` : un filtre et une transformation à la fois), garde
   les 2 premiers et les 2 derniers ; le `Set` évite les doublons sur une page
   courte.
3. `findRepeatedMarginLines` renvoie un ensemble vide sous 3 pages. Sinon,
   `occurrences` compte le nombre de **pages** où chaque signature est en
   marge (un `Set` par page : un doublon sur la même page compte une fois).
4. Seuil : le plus grand de 3 et de la moitié des pages arrondie au-dessus.
   Pour 6 pages, `max(3, 3)` = 3 ; pour 20 pages, 10.

`removeMarginLines` recalcule les indices de marge d'une page, retire ceux
dont la signature est répétée, et note dans `removed` le premier exemple de
chaque signature. Une ligne identique au milieu de la page n'est jamais
candidate.

### `joinText()`

Chaînes vides mises à part : si la gauche finit par lettre + `-`
(`/\p{L}-$/u`) et que la droite commence par une minuscule (`/^\p{Ll}/u`), on
retire le tiret et on colle (`conn-` + `exion`). Sinon, une espace. Le drapeau `u` couvre les lettres accentuées. `chunk.ts`
réutilise cette fonction pour les paragraphes coupés par un saut de page.

### `buildParagraphs()` et `percentile()`

```ts
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
```

**Ce que fait le code**, dans l'ordre du code :
1. Avant la boucle : la longueur d'une ligne « pleine » est le 80ᵉ percentile
   des longueurs de la page (`percentile` trie une copie et prend le rang
   `floor(n × 0.8)`) ; `isShort` = sous 80 % de cette longueur. `flush()`
   pousse le paragraphe en cours s'il n'est pas vide.
2. Ligne vide (posée par `linesToText` ou par la suppression d'un en-tête) :
   fin de paragraphe.
3. Puce ou numérotation (`BULLET`) : on ferme le paragraphe précédent.
4. La ligne est recollée avec `joinText`, césures comprises.
5. Ligne courte **et** (ponctuation forte en fin, ou suivante qui commence par
   une majuscule ou un chiffre) : fin de paragraphe. Une ligne pleine qui
   finit par un point ne ferme rien.
6. Le `flush()` final enregistre le dernier paragraphe.
   Mesurer « court » par rapport à la page évite de dépendre de la mise en
   page.

---

## `apps/api/src/rag/text/chunk.ts`

Transforme les pages nettoyées en chunks d'environ 500 tokens, coupés de
préférence sur une fin de paragraphe, avec recouvrement.

`chunkPages()` fixe la cible (500) et le recouvrement
(`Math.round(500 × 0.15)` = 75 tokens), construit la liste plate des phrases
du document avec `toParagraphs` et `toUnits`, puis appelle `assemble`.

### `toParagraphs()`

```ts
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
```

**Ce que fait le code**, dans l'ordre du code :
1. `texts` : les paragraphes de la page (découpe sur `"\n\n"`).
2. Le **premier** paragraphe d'une page continue le dernier connu si celui-ci
   ne finit pas par une ponctuation forte et que le nouveau commence par une
   minuscule.
3. On recolle, et `pageOffsets` note à quel caractère commence la portion de
   la nouvelle page : `joined.length - text.length`.
4. Sinon, nouveau paragraphe, qui commence à l'offset 0 de sa page.

Exemple : page 1 finit par « Les frais de connexion sont » (27 caractères),
page 2 commence par « remboursés. » (11). `joined` fait 27 + 1 + 11 = 39
caractères, la page 2 commence à l'offset 39 − 11 = 28 :
`[{ offset: 0, pageNumber: 1 }, { offset: 28, pageNumber: 2 }]`.

### `toUnits()` et `splitOversized()`

```ts
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
```

**Ce que fait le code**, dans l'ordre du code :
1. `pageAt(offset)` : la dernière entrée de `pageOffsets` dont l'offset est
   inférieur ou égal, donc la page d'un caractère.
2. `sentenceSegmenter` est un `Intl.Segmenter("fr", { granularity:
   "sentence" })`, intégré à Node : il renvoie chaque phrase et sa position
   `index`.
3. Page du premier caractère, page du dernier caractère hors espaces : la
   phrase de l'exemple ci-dessus a `pageStart` 1 et `pageEnd` 2.
4. `splitOversized` laisse passer une phrase qui tient dans la cible ; sinon,
   il avance mot par mot et ferme un morceau dès que le mot suivant ferait
   dépasser 500 tokens (cas d'un tableau aplati).
5. La dernière unité du paragraphe reçoit `endsParagraph = true`, information
   qu'utilisera `chooseCut`.

### `assemble()`

C'est le cœur de l'algorithme.

```ts
function assemble(units: Unit[], target: number, overlap: number, countTokens: TokenCounter): Chunk[] {
  const chunks: Chunk[] = [];
  const emit = (selected: Unit[]) => chunks.push(toChunk(chunks.length, selected, countTokens));

  /** Unités du chunk en cours ; les `overlapCount` premières viennent du chunk précédent (recouvrement). */
  let window: Unit[] = [];
  let overlapCount = 0;

  for (const unit of units) {
    // On ferme le chunk si l'unité le ferait déborder… à condition qu'il
    // contienne autre chose que le recouvrement (sinon on n'avancerait pas).
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

**Ce que fait le code**, dans l'ordre du code :
1. `emit` transforme des unités en `Chunk` (via `toChunk`), avec pour index
   le nombre de chunks déjà émis.
2. `window` est le chunk en cours ; ses `overlapCount` premières unités sont
   le recouvrement repris du précédent.
3. **Avant** d'ajouter une unité, on regarde si elle ferait dépasser la
   cible. Si oui, et si la fenêtre contient autre chose que du recouvrement :
   - `chooseCut` dit combien d'unités émettre (pas forcément toutes) ;
   - les `cut` premières sont émises ;
   - `overlapTail` choisit les dernières unités émises à répéter ;
   - nouvelle fenêtre = ce recouvrement + les unités non émises
     (`window.slice(cut)`).
4. C'est un `while` : si `chooseCut` a laissé beaucoup d'unités, la fenêtre
   peut encore déborder, et on recoupe.
5. L'unité entre. À la fin, le reste est émis, sauf s'il n'est que du
   recouvrement (déjà présent dans le chunk précédent).

**Pourquoi c'est écrit ainsi** :
- `window.length > overlapCount` empêche une boucle infinie : une fenêtre
  faite seulement de recouvrement serait émise, reprise, réémise…
- Tester **avant** d'ajouter : un chunk ne dépasse la cible que si une seule
  unité, ajoutée au recouvrement, la fait dépasser.

### `chooseCut()`

```ts
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

**Ce que fait le code**, dans l'ordre du code :
1. Par défaut `best = window.length` : tout émettre, donc couper sur la
   dernière fin de phrase.
2. On cumule les tokens unité par unité.
3. Une unité est candidate si elle n'est pas dans le recouvrement, termine un
   paragraphe, et si le cumul atteint 60 % de la cible (300 tokens).
4. Chaque candidate écrase la précédente : on garde la **dernière** fin de
   paragraphe acceptable, celle qui donne le chunk le plus plein.

### `overlapTail()`

Le code est dans le cours (leçon 5). Pas à pas :
1. On part de la dernière unité émise et on remonte (`i--`).
2. `i > 0` : on ne prend jamais la première unité, donc jamais tout le chunk.
3. On continue tant que le total est sous `overlap` (75).
4. Si l'unité porterait le total au-delà de `overlap * 2` (150) : `break`,
   sans la prendre.
5. `tail.unshift(unit)` ajoute au début : l'ordre du texte est conservé.

Le recouvrement fait donc 75 à 150 tokens quand c'est possible, moins si la
dernière phrase est longue, et il peut être vide.

### Un exemple chiffré

Cible 500, recouvrement 75 (plafond 150), seuil de paragraphe 300. Neuf
phrases, notées par leurs tokens ; ¶ marque une fin de paragraphe :

| Unité | A | B | C | D | E | F | G | H | I |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tokens | 200 | 120 ¶ | 150 | 50 | 60 | 40 ¶ | 180 | 160 ¶ | 70 |

**Chunk #0.** A, B, C entrent : `[A, B, C]`, 470. D mènerait à 520 : on
coupe. `chooseCut` : après B ¶, 320 ≥ 300, `best = 2` ; C n'est pas une fin
de paragraphe. On émet `[A, B]` (320) : **C attend le chunk suivant**.
`overlapTail([A, B])` : B (120 ≤ 150) est prise, 120 ≥ 75, stop. Fenêtre
`[B, C]`, `overlapCount = 1`, 270. Avec D : 320, plus de débordement, D
entre.

**Chunk #1.** E, F entrent : `[B, C, D, E, F]`, 420. G mènerait à 600 : on
coupe. `chooseCut` : B ¶ est ignorée (`i = 0 < overlapCount`), F ¶ à 420
donne `best = 5`, toute la fenêtre est émise. `overlapTail` : F (40), total
40 < 75, on continue ; E (60), total 100, stop. Fenêtre `[E, F]`,
`overlapCount = 2` : le `while` ne peut pas recouper (2 > 2 est faux), G
entre. `[E, F, G]`, 280.

**Chunk #2.** H entre : `[E, F, G, H]`, 440. I mènerait à 510 : on coupe.
`chooseCut` : F ¶ est dans le recouvrement, H ¶ à 440 donne `best = 4`. On
émet `[E, F, G, H]`. `overlapTail` : H fait 160 > 150, `break` immédiat,
**recouvrement vide**. Fenêtre `[]`, I entre.

**Chunk #3.** Plus d'unités ; `[I]` contient autre chose que du
recouvrement, il est émis.

| Chunk | Unités | Tokens (somme) | Repris du précédent |
| --- | --- | --- | --- |
| #0 | A B | 320 | — |
| #1 | B C D E F | 420 | B (120) |
| #2 | E F G H | 440 | E F (100) |
| #3 | I | 70 | — |

À retenir de l'exemple : une coupure sur fin de paragraphe peut laisser des
phrases pour plus tard (C) ; le recouvrement dépasse 75 quand une phrase
entière le fait dépasser (B) ; il disparaît quand la dernière phrase est trop
longue (H) ; le dernier chunk d'un document peut être petit. `toChunk`
recompte ensuite les tokens sur le texte final.

### `toChunk()`

`content` assemble les textes ; le séparateur dépend de l'unité **précédente** : `"\n\n"` si elle terminait un
paragraphe, une espace sinon, rien pour la première. Les pages vont de la
plus petite page de début à la plus grande page de fin (d'où « p. 1–2 »).
`tokenCount` est recompté sur le texte, séparateurs compris. `sumTokens`
additionne simplement les `tokens` d'une liste.

---

## `apps/api/src/rag/document.ts`

`splitPdf(pdfBytes)` enchaîne `extractPages`, `cleanPages` et `chunkPages`
avec le vrai `countTokens` et les constantes exportées
`CHUNK_TARGET_TOKENS = 500` et `CHUNK_OVERLAP_RATIO = 0.15`. Il renvoie
`pageCount` (calculé sur les pages **brutes**), `chunks` et
`removedMarginLines`. Rien n'est écrit. `rag:preview` et `ingest` appellent la
même fonction : l'aperçu montre exactement ce qui sera ingéré.

---

## `apps/api/src/rag/embeddings/` : contrat et lots

`types.ts` définit `EmbeddingClient` : `dimension`,
`embedDocuments(texts, options)` qui renvoie `{ vectors, totalTokens }`, et
`embedQuery(text, options)` qui renvoie un vecteur. `EmbedOptions` porte un
`signal` d'annulation et un rappel `onBatch`. `factory.ts` traduit
`EMBEDDING_PROVIDER` en instance par un `switch` (seul `"voyage"` existe,
toute autre valeur lève une erreur). `index.ts` réexporte types et fabrique :
le reste du RAG ne voit jamais `voyage.ts`.

### `planBatches()` (`batch.ts`)

Une boucle `forEach` sur les textes, qui compte leurs tokens :
1. Avant d'ajouter un texte, on ferme le lot s'il est plein (`maxTexts`) ou si
   le texte ferait dépasser `maxTokens`.
2. `current.length > 0` : un texte seul, même énorme, forme au moins un lot.
3. On range l'**indice** du texte, pas le texte.

300 chunks avec `maxTexts = 128` : lots 0–127, 128–255, 256–299. Les indices
permettent ensuite de ranger chaque vecteur à la place de son texte.

---

## `apps/api/src/rag/embeddings/retry.ts`

`EmbeddingApiError` (code dans le cours, leçon 6) porte `status` et
`retryAfterMs` ; `retryable` vaut vrai pour 429 et 5xx.

### `withRetry()`

```ts
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
```

**Ce que fait le code**, dans l'ordre du code :
1. Boucle sans condition : on en sort par `return` (succès) ou `throw`.
2. `return await` est nécessaire : sans `await`, un rejet échapperait à ce
   `catch`.
3. On relance l'erreur si les tentatives sont épuisées, si elle n'est pas
   passagère, ou si l'utilisateur a annulé.
4. Délai : `1000 × 2^(tentative − 1)`, plafonné à 30 000 ms, puis tiré au
   hasard entre la moitié et la totalité. Tentative 3 : entre 2 000 et
   4 000 ms.
5. Un `Retry-After` envoyé par le serveur impose un minimum.
6. `onRetry` journalise ; `sleep` (version promesse de `setTimeout`) attend,
   et le `signal` interrompt l'attente sur Ctrl+C.

`isTransient` accepte trois cas : une `EmbeddingApiError` `retryable`, un
`TypeError` de message `"fetch failed"` (coupure réseau, DNS), et une
`DOMException` `TimeoutError` (délai de 60 s dépassé). Une annulation par
Ctrl+C est une `AbortError` : elle n'est pas réessayée.

---

## `apps/api/src/rag/embeddings/voyage.ts`

Le seul fichier qui connaît l'API Voyage : un `POST /v1/embeddings` en
`fetch`, sans SDK.

### `embedDocuments()` et `embedQuery()`

```ts
      const response = await this.request(indices.map((index) => texts[index]!), "document", options.signal);
      response.data.forEach((item) => {
        vectors[indices[item.index]!] = item.embedding;
      });
```

`embedDocuments`, pas à pas :
1. Limite de tokens par requête selon le modèle (320 000 pour `voyage-3.5`,
   120 000 pour un modèle inconnu), réduite à 80 % car notre compteur n'est
   pas celui de Voyage.
2. Lots d'au plus 128 textes, `vectors` préalloué à la bonne taille.
3. Les lots partent **l'un après l'autre** (`await` dans la boucle).
4. Chaque élément de la réponse porte son `index` dans le lot ;
   `indices[item.index]` donne sa place dans le tableau d'origine.
5. On cumule les tokens facturés et on signale la progression.

`embedQuery` envoie `[text]` avec `"query"` et renvoie le premier vecteur.
Sans chunk (PDF scanné), `planBatches` renvoie zéro lot : aucun appel réseau.

### `request()`

`request()` enveloppe `post()` dans `withRetry` avec `RETRY` (8 nouvelles
tentatives, 1 s de base, 30 s de plafond) et un `onRetry` qui affiche
`[voyage] HTTP 429 — tentative 2/9 dans 1000 ms` (1 essai + 8 nouvelles
tentatives = 9). Puis il vérifie qu'il y a autant de vecteurs que de textes,
et que chacun a la dimension attendue : sinon, erreur **avant** toute écriture.

### `post()` et `parseRetryAfter()`

```ts
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.baseUrl}/embeddings`, {
// …
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      // Le corps d'erreur de Voyage ({ detail: "..." }) ne contient jamais nos textes.
      const detail = await response.text().catch(() => "");
      throw new EmbeddingApiError(
        `Voyage a répondu HTTP ${response.status}${detail ? ` : ${detail.slice(0, 300)}` : ""}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return (await response.json()) as VoyageResponse;
```

**Ce que fait le code**, dans l'ordre du code :
1. Un délai de 60 s, recréé à **chaque** tentative.
2. Dans la partie coupée : en-tête `Authorization: Bearer <clé>`, corps JSON
   avec `input`, `model`, `input_type`, `output_dimension` et
   `truncation: false` (un texte trop long échoue au lieu d'être tronqué).
3. `AbortSignal.any` : le Ctrl+C ou le délai, le premier des deux annule.
4. Réponse non `ok` : corps lu sans risque (`catch`), tronqué à 300
   caractères, et `EmbeddingApiError` avec le statut et `Retry-After`.

`parseRetryAfter` lit l'en-tête sous ses deux formes : secondes (× 1000) ou
date HTTP (écart avec maintenant, jamais négatif) ; sinon `undefined`.

---

## `apps/api/src/rag/db/repository.ts`

Tout le SQL du RAG. `toSqlVector` écrit un tableau sous la forme texte que
pgvector lit, `[0.12,-0.03,…]`. `getDocumentHashes` charge en une requête
une `Map` nom de fichier → sha256. `listDocuments` (ajoutée au jour 2,
cours 3) liste les documents et leur nombre de chunks.

### `replaceDocument()`

```ts
    await client.query("BEGIN");

    // Les anciens chunks partent avec le document (ON DELETE CASCADE).
    await client.query("DELETE FROM documents WHERE file_name = $1", [doc.fileName]);

    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO documents (file_name, sha256) VALUES ($1, $2) RETURNING id",
      [doc.fileName, doc.sha256],
    );
    const documentId = rows[0]!.id;

    // Une seule requête pour tous les chunks : chaque colonne est envoyée
    // comme un tableau, et unnest() les « dézippe » en lignes.
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
```

**Ce que fait le code**, dans l'ordre du code :
1. Une connexion dédiée (`pool.connect()`, avant l'extrait) et `BEGIN`.
2. `DELETE` de l'ancienne version ; la cascade emporte ses chunks. Pour un
   nouveau fichier, aucune ligne n'est touchée.
3. `INSERT … RETURNING id` récupère l'identifiant. Il est typé `string` : le
   pilote `pg` renvoie les `bigint` en texte, et on le repasse tel quel.
4. Les chunks partent **colonne par colonne** : six tableaux JS, que `pg`
   transmet comme tableaux Postgres.
5. `unnest` à plusieurs arguments les « dézippe » : la ligne n prend le n-ième
   élément de chaque tableau (`$2 = {0,1,2}`, `$3 = {1,1,2}`… : 3 lignes).
   `AS t(…)` nomme les colonnes, `::vector` convertit le texte en vecteur.
6. `COMMIT`. Après l'extrait : `ROLLBACK` et relance de l'erreur en cas
   d'échec, `client.release()` dans le `finally`.

**Pourquoi c'est écrit ainsi** : une seule requête pour tous les chunks (un
aller-retour, toujours 7 paramètres), et aucun appel réseau dans la
transaction, qui ne dure que le temps de quelques écritures.

### `SEARCH_SQL` et `searchChunks()`

La requête est dans le cours (leçon 8). `searchChunks` l'exécute avec
`[toSqlVector(queryVector), limit]`, puis traduit chaque ligne
(`file_name` → `fileName`, etc.) et passe le score par `Number()`. Elle est
aujourd'hui appelée par `retrieve.ts`, plus directement par le script.

---

## `apps/api/src/rag/scripts/ingest.ts`

Le script `npm run ingest`, qui orchestre tout le reste.

### `main()`

1. Config, client d'embeddings, pool.
2. Le Ctrl+C (`SIGINT`) déclenche l'`AbortController`, dont le `signal` va
   jusqu'à `fetch` et `sleep`. `once` : un second Ctrl+C retrouve le
   comportement par défaut de Node.
3. Dimension vérifiée, PDF listés, empreintes chargées.
4. Fichiers traités **un par un** ; après une annulation, on s'arrête avant le
   suivant. Chaque résultat (`ingested`, `skipped`, `failed`) est compté.
5. Après la boucle : les documents en base mais absents du dossier sont
   signalés, **pas** supprimés ; bilan ; `process.exitCode = 1` en cas
   d'échec ; `pool.end()` dans le `finally`.

### `ingestFile()`

```ts
    const bytes = await readFile(path.join(PDF_DIR, fileName));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 === knownHash) {
      console.log(`= ${fileName} : inchangé, ignoré`);
      return "skipped";
    }

    // 1. Découpage (local, rapide).
    const { pageCount, chunks } = await splitPdf(bytes);
    if (chunks.length === 0) {
      console.warn(`⚠ ${fileName} : aucun texte extrait (PDF scanné ?)`);
    }

    // 2. Embeddings (réseau, lent) — avant d'ouvrir la transaction.
    const { vectors, totalTokens } = await deps.embedder.embedDocuments(
      chunks.map((chunk) => chunk.content),
      { signal: deps.signal },
    );

    // 3. Écriture (transaction courte).
    await replaceDocument(deps.pool, { fileName, sha256, chunks, embeddings: vectors });
```

**Ce que fait le code**, dans l'ordre du code :
1. Empreinte sha256 en hexadécimal : 64 caractères, d'où `char(64)`.
2. Même empreinte qu'en base : on s'arrête, sans appel à Voyage.
3. Découpage. Zéro chunk n'arrête rien : avertissement, et le document sera
   enregistré sans chunk, avec son empreinte.
4. Embeddings de tous les chunks, avec le signal d'annulation.
5. Écriture dans une transaction.
6. Après l'extrait : un log de métadonnées (« nouveau » si `knownHash` est
   `undefined`, sinon « modifié, réingéré »). Le `catch` qui entoure le tout
   affiche `✗ fichier : message` et renvoie `"failed"` sans arrêter les
   autres fichiers.

**Pourquoi c'est écrit ainsi** : si Voyage échoue, rien n'a été écrit et
l'ancienne empreinte reste en base : le fichier sera retenté la fois suivante.

`listPdfs` utilise `readdir(dir, { recursive: true, withFileTypes: true })`,
garde les fichiers `.pdf` (casse ignorée), calcule leur chemin relatif à
`data/pdfs/` (ce sera le `file_name`, par exemple `rh/guide-rh.pdf`) et trie.

---

## Les autres scripts

- **`scripts/migrate.ts`** : `runMigrations(pool, { EMBEDDING_DIMENSION })`,
  affiche les migrations appliquées ou « Schéma déjà à jour », puis appelle
  `assertEmbeddingDimension`. Une `ConfigError` s'affiche sans pile d'appels.
- **`scripts/preview.ts`** : `parseArgs` lit le fichier et `--short`. Un
  chemin qui n'existe pas est cherché dans `PDF_DIR`. Le script appelle
  `splitPdf`, affiche chaque chunk (200 caractères avec `--short`), puis
  pages, nombre de chunks, tokens min / moy / max, en-têtes détectés, durée.
  Ni base, ni réseau.
- **`scripts/embed-check.ts`** : `embedDocuments` sur trois passages,
  `embedQuery` sur la question fil rouge, puis norme et similarités cosinus
  recalculées en JS (produit scalaire divisé par le produit des normes).
- **`scripts/search.ts`** : vérifie la dimension, puis passe par
  `createRetriever({ pool, embedder })` et `retrieve(question, { k: DEFAULT_K })`
  (ajouté au jour 2, cours 2 : voir
  [son approfondissement](jour-2-recherche-reponse.md)). Avec `--explain`, il
  lance `EXPLAIN ANALYZE` sur `SEARCH_SQL` avec un vecteur de sonde (toutes
  les composantes à `1/√dimension`, donc de norme 1) : le plan ne dépend pas
  des valeurs, et cela évite un second appel Voyage.

---

## Pour explorer toi-même

- `npm run rag:preview -- guide-rh.pdf --short`, puis la même commande après
  avoir passé `CHUNK_TARGET_TOKENS` à 300 dans `document.ts` : compare le
  nombre de chunks et les tokens min / moy / max.
- Dans `assemble()`, juste après `const emitted = …`, ajoute
  `console.log(cut, window.length, overlapCount, sumTokens(emitted))` et
  relance `rag:preview` : tu vois quand `chooseCut` coupe avant la fin de la
  fenêtre.
- Dans `overlapTail()`, juste avant `return tail`, journalise `tail.length`
  et `tokens` : repère les recouvrements vides.
- Le contenu de la base :
  `docker compose exec postgres psql -U rag -d rag -c "select d.file_name, c.chunk_index, c.page_start, c.page_end, c.token_count from chunks c join documents d on d.id = c.document_id order by 1, 2"`.
- La vérification de `assertEmbeddingDimension`, à la main :
  `docker compose exec postgres psql -U rag -d rag -c "select format_type(atttypid, atttypmod) from pg_attribute where attrelid = to_regclass('chunks') and attname = 'embedding'"`.
