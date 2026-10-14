# Jour 3 · Cours 1 — La recherche hybride

> [Sommaire](README.md) · Précédent : [Jour 2 · Cours 3 — Le jeu de test](jour-2-jeu-de-test.md) · [Approfondissement : le code](approfondissement/jour-3-hybride.md)

> **Prérequis.** [Le jeu de test](jour-2-jeu-de-test.md) : 20 questions,
> `eval:run` et `eval:score`. La recherche est vectorielle seulement.
>
> **Le fil rouge.** `ns338233`, le nom de la machine de prod de
> DiscordInvites. Tapé tel quel, la recherche vectorielle ne le retrouve
> pas dans ses 5 premiers résultats.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Pourquoi deux recherches ? |
| 1 | Comment Postgres cherche-t-il des mots ? |
| 2 | Comment interroger avec une question entière, et classer ? |
| 3 | Les identifiants exacts sont-ils retrouvés ? |
| 4 | Comment fusionner deux classements ? |
| 5 | Comment choisir le mode ? |
| 6 | Qu'est-ce que ça change sur le jeu de test ? |
| 7 | Que se passe-t-il quand ça se passe mal ? |
| 8 | Synthèse et corrigé |

---

## Leçon 0 : pourquoi deux recherches ?

La recherche vectorielle compare le **sens** : elle comprend « je bosse
depuis mon salon » = « télétravail ». Mais un identifiant comme `ns338233`
n'a pas de sens pour un modèle d'embeddings : c'est une suite de caractères.
La recherche **plein texte** compare les **mots** : elle est bête, mais
exacte. La recherche **hybride** lance les deux et fusionne les classements.

```
question ──┬─► embedding Voyage ─► pgvector (<=>) ─► 20 candidats ─┐
           └─► to_tsvector('french') ─► GIN (@@) ─► 20 candidats ─┴─► RRF ─► 5 chunks
```

Ajouté : la migration `002_fulltext.sql`, `searchLexical` et `fuseByRrf`,
l'option `mode` de `retrieve` (défaut : `RAG_SEARCH_MODE`), `search --mode`,
`eval:run --mode` et `eval:compare`.

> **À retenir**
> Le sens et les mots se complètent : l'une rate les termes exacts, l'autre
> les reformulations.

---

## Leçon 1 : le plein texte dans Postgres

```sql
ALTER TABLE chunks
    ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('french', content)) STORED;

CREATE INDEX chunks_content_tsv_idx ON chunks USING gin (content_tsv);
```

- `to_tsvector('french', …)` **retire les mots vides** (« le », « de »,
  « et » : partout, donc inutiles) et **racinise** : « déplacements »,
  « déplacer » → `déplac`. « Je me déplace » trouve donc « frais de
  déplacement ».
- **La langue compte** : les terminaisons à couper et la liste des mots vides
  sont propres à chaque langue. En `'english'`, « sécurité » resterait entier
  et « le » ne serait pas retiré.
- **Colonne générée** : Postgres l'a remplie pour les 13 chunks existants et
  la recalcule à chaque insertion. L'ingestion n'a pas changé.
- **Index GIN** (inversé) : pour chaque mot, la liste des chunks qui le
  contiennent. Avec 13 chunks Postgres préfère lire la table (normal) ; en
  forçant, on voit `Bitmap Index Scan on chunks_content_tsv_idx`.

> **À retenir**
> On indexe des mots normalisés ; la normalisation dépend de la langue.

**Question**
1. Pourquoi « securite » (sans accent) ne trouve-t-il rien ?

---

## Leçon 2 : interroger avec une question, et classer

```sql
WITH q AS (
  SELECT array_to_string(array_agg(quote_literal(lexeme)), ' | ')::tsquery AS query
  FROM unnest(to_tsvector('french', $1))
)
```

- `plainto_tsquery` relie les mots par **ET** : « C'est quoi le hostname de
  la machine de prod ? » donne `'quoi' & 'hostnam' & 'machin' & 'prod'`, et
  presque aucun chunk ne contient les quatre. On normalise la question comme
  les chunks, puis on relie ses mots par **OU** (`|`) : le classement trie.
- `ts_rank` classe : plus les termes de la question apparaissent, plus le
  score monte (0,007 à 0,08 ici, sans borne fixe).

| | `ts_rank` | BM25 (Elasticsearch, Lucene…) |
| --- | --- | --- |
| Fréquence du mot dans le chunk | oui | oui, **plafonnée** |
| Rareté du mot dans le corpus (IDF) | **non** | oui |
| Longueur du chunk | ignorée par défaut | compensée |

Sans IDF, `ts_rank` donne autant de poids à « prod » qu'à « ns338233 ».

> **À retenir**
> OU pour trouver, le classement pour trier. `ts_rank` est un BM25 simplifié,
> sans rareté des mots.

**Question**
1. Pourquoi l'absence d'IDF pénalise-t-elle surtout les questions longues ?

---

## Leçon 3 : les identifiants exacts

`ts_debug('french', …)` montre le découpage :

| Texte | Découpage | Plein texte | Vectoriel |
| --- | --- | --- | --- |
| `ns338233` | `ns338233`, entier | **#1**, seul résultat | **absent du top 5** |
| `union.ovh` | `union.ovh`, entier (jeton *host*) | #1, seul résultat | #2 |
| `GAME_KEYWORDS` | ⚠️ `gam` + `keyword` | #1 | #1 |
| `prod-01` | ⚠️ `prod` + `-01` | — | — |

- Les constantes **perdent leur exactitude** : `GAME_SETTINGS`, qui n'existe
  pas, trouve le chunk de `GAME_KEYWORDS` grâce à `gam`.
- Un domaine reste un bloc : « union » ne trouve pas `union.ovh`.
- Les accents comptent : « securite » ne trouve rien.

**Solution simple, non implémentée** : repérer dans la question les jetons
qui ressemblent à un identifiant (`_`, `.`, chiffre, MAJUSCULES), les
chercher tels quels (`content ILIKE '%GAME_KEYWORDS%'`, accéléré par un
index trigramme `pg_trgm`), et ajouter ces résultats comme troisième liste à
la fusion. Pour les accents : une configuration `french` avec `unaccent`.

> **À retenir**
> Le plein texte retrouve les identifiants tapés tels quels, mais le parseur
> en découpe certains : à vérifier avec `ts_debug`, pas à supposer.

---

## Leçon 4 : fusionner deux classements (RRF)

```ts
lists[name].forEach((chunk, i) => {
  const rank = i + 1;
  // Un chunk est identifié par son document et sa position dans celui-ci.
  const key = `${chunk.fileName}#${chunk.chunkIndex}`;
  const entry = fused.get(key) ?? { ...chunk, score: 0, ranks: { vector: null, lexical: null } };
  entry.ranks[name] = rank;
  entry.score += 1 / (RRF_K + rank);
  fused.set(key, entry);
});
```

`score = Σ 1 / (60 + rang)`, sur chaque recherche où le chunk apparaît.

- **On fusionne des rangs, pas des scores** : un cosinus (≈ 0,4, resserré) et
  un `ts_rank` (≈ 0,05, sans borne) ne sont pas sur la même échelle. Les
  normaliser est fragile : un `ts_rank` seul résultat deviendrait 1,0.
- **k = 60 écrase les écarts** : rang 1 = 0,0164, rang 10 = 0,0143. Être
  **dans les deux listes** rapporte bien plus que d'être 1er dans une seule.
- **20 candidats par recherche** : un chunk 9e d'un côté et 1er de l'autre
  peut remonter. `ns338233` : `vecteur #9 · plein texte #1` →
  1/69 + 1/61 = 0,0309, premier.
- Les deux recherches partent **en parallèle** (`Promise.all`) : la durée est
  celle de la plus lente.

> **À retenir**
> RRF récompense l'accord entre les recherches, sans jamais comparer leurs
> scores.

**Question**
1. Notre base n'a que 13 chunks. Avec 20 candidats, que contient toujours la
   liste vectorielle, et quelle conséquence pour la fusion ?

---

## Leçon 5 : choisir le mode

```ts
return async (question, { k = DEFAULT_K, mode = defaultMode, signal } = {}) => {
```

- `mode` vaut `"vector"`, `"lexical"` ou `"hybrid"`. Sans précision, c'est
  `RAG_SEARCH_MODE` (`.env`), lue et validée au démarrage ; absente :
  `vector`.
- `/chat` n'a pas changé : il appelle `retrieve`, qui applique le mode par
  défaut.
- En hybride, le `score` envoyé à l'interface est le score RRF (≈ 0,03).

---

## Leçon 6 : la mesure

`npm run eval:run -- --mode hybrid` enregistre le mode dans la configuration
du run. `npm run eval:compare -- <A> <B> <C>` calcule, **sans notation
manuelle**, le rang du bon passage :

```ts
const match = chunks
  .filter((chunk) => chunk.fichier === expected.fichier && chunk.pages.some((page) => expected.pages.includes(page)))
  .sort((a, b) => a.rang - b.rang)[0];
```

- **Bon passage** = un chunk du bon fichier qui partage au moins une page
  avec les pages attendues. Une question « combinaison » n'est trouvée que si
  toutes ses sources le sont.
- Les 4 questions sans réponse n'ont rien à trouver : total sur 16.
- Deux indicateurs : **dans les 5 premiers** (ce que reçoit le modèle) et
  **au 1er rang** (plus fin : le top 5 sature vite sur 13 chunks).

RESULTATS_A_COMPLETER

---

## Leçon 7 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| Question faite de mots vides (« et le de ») | la requête plein texte est vide (`NULL`) : aucun résultat lexical ; en hybride, seule la liste vectorielle compte |
| Quota Voyage dépassé | `vector` et `hybrid` attendent (réessais) ; `lexical` n'appelle pas Voyage |
| Voyage en panne | `hybrid` échoue entièrement (`Promise.all`), pas de repli sur le plein texte |
| `RAG_SEARCH_MODE` invalide | le serveur refuse de démarrer, avec la liste des valeurs permises |
| Runs comparés avec d'autres documents ou questions | `eval:compare` affiche un avertissement |
| Ancien run sans mode enregistré | lu comme `vector` |

---

## Leçon 8 : synthèse

### Les idées à emporter

1. Le vectoriel comprend le sens, le plein texte retrouve les termes exacts.
2. La normalisation (mots vides, racinisation) dépend de la langue.
3. Une question se cherche en OU ; `ts_rank` n'a pas d'IDF, contrairement à
   BM25.
4. Le parseur découpe certains identifiants : on le vérifie avec `ts_debug`.
5. RRF fusionne des rangs, pas des scores, et récompense l'accord.
6. Une note de recherche se calcule par code à partir des pages attendues.

### Vérifications manuelles

```bash
npm run db:migrate                                         # applique 002_fulltext.sql
npm run search -- --mode lexical "ns338233"                # 1 résultat, chunk 1
npm run search -- "ns338233"                               # vectoriel : le chunk 1 n'est pas dans le top 5
npm run search -- --mode hybrid "ns338233"                 # vecteur #9 · plein texte #1 → 1er
npm run search -- --mode lexical "GAME_SETTINGS"           # faux positif via « gam »
npm run eval:run -- --mode hybrid                          # un run en hybride
npm run eval:compare -- <run A> <run B> <run C>            # rangs et totaux par type
```

### Pour aller plus loin (non fait, volontairement)

Recherche exacte des identifiants (`pg_trgm`), `unaccent`, un vrai BM25
(ParadeDB, Elasticsearch), RRF pondérée, reranking, repli sur une seule
recherche si l'autre échoue.

---

## Corrigé des questions

**L1.1** `french` racinise mais ne retire pas les accents : « securite »
donne `securit`, « sécurité » donne `sécur`. Il faudrait `unaccent`.

**L2.1** Une question longue apporte beaucoup de mots courants ; sans IDF,
chacun pèse autant que le mot rare et discriminant, qui se noie.

**L4.1** Toute la base : chaque chunk trouvé par le plein texte cumule donc
deux contributions et passe devant les autres. Sur une grande base, l'effet
serait bien plus faible.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-3-hybride.md).
