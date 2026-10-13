# Jour 2 · Cours 1 — L'ingestion d'un RAG

> [Sommaire](README.md) · Précédent : [Jour 1 · Cours 2 — Le tool use](jour-1-appel-doutils.md) · Suivant : [Jour 2 · Cours 2 — La réponse sourcée](jour-2-recherche-reponse.md)

> **Prérequis.** Les deux cours du jour 1. Le chatbot tourne avec tool use, et
> ce cours **n'y touche pas** : il construit à côté la première moitié d'un
> RAG, des PDF jusqu'aux vecteurs stockés dans Postgres.
>
> **Le fil rouge.** `guide-rh.pdf` (6 pages), dans `apps/api/data/pdfs/`. La
> question « Combien est-ce qu'on me rembourse pour ma box quand je bosse de
> chez moi ? » doit retrouver « Les frais de connexion sont remboursés… »,
> sans aucun mot en commun.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'est-ce qu'un RAG, et quelle moitié construisons-nous ? |
| 1 | Où stocker les vecteurs, et avec quel schéma ? |
| 2 | Quand un index vectoriel devient-il utile ? |
| 3 | Comment lire un PDF sans perdre les pages ni les paragraphes ? |
| 4 | Comment nettoyer le texte (en-têtes, césures, caractères) ? |
| 5 | Comment découper en chunks d'environ 500 tokens, avec recouvrement ? |
| 6 | Comment obtenir les vecteurs de façon fiable ? |
| 7 | Comment ingérer sans doublon et sans état à moitié écrit ? |
| 8 | Comment chercher, et que fait l'opérateur `<=>` ? |
| 9 | Quand ça se passe mal |
| 10 | Synthèse |

---

## Leçon 0 : vue d'ensemble

**L'idée en une phrase.** Un RAG (*Retrieval-Augmented Generation*)
**retrouve** les passages pertinents de tes documents, puis les **donne au
modèle** avec la question. On retrouve par le **sens** grâce aux
**embeddings** : 1024 nombres par texte, proches quand les sens sont proches.

```
INGESTION (ce cours) : PDF ─► pages ─► texte propre ─► chunks ─► vecteurs (Voyage) ─► Postgres
INTERROGATION (plus tard) : question ─► vecteur ─► 5 chunks les plus proches ─► LLM
```

L'ingestion est un **script séparé du serveur** : lente, elle ne tourne que
quand les documents changent. Nous avons ajouté `docker-compose.yml`
(Postgres 17 + pgvector, port 5433) et `apps/api/src/rag/` : `db/` (migration,
`repository.ts` qui regroupe tout le SQL), `pdf/`, `text/` (fonctions
**pures**), `embeddings/` (seul `voyage.ts` connaît l'API), et les scripts
`db:migrate`, `rag:preview`, `rag:embed-check`, `ingest`, `search`.

> **À retenir**
> Ce cours construit « retrouver » : PDF → chunks → vecteurs → Postgres →
> recherche par proximité de sens.

**Questions**
1. Pourquoi une recherche par mots-clés (`LIKE '%box%'`) ne suffirait-elle
   pas pour la question fil rouge ?

---

## Leçon 1 : la base vectorielle et le schéma

Pour chaque morceau de texte, il faut stocker contenu, pages, document **et**
vecteur, puis demander « les 5 plus proches ». **pgvector** ajoute à Postgres
un type `vector(n)` et des opérateurs de distance : tout reste dans la même
base, avec jointures, transactions et contraintes.

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

- Le `sha256` appartient au fichier (a-t-il changé ?), le vecteur au chunk.
  `ON DELETE CASCADE` : supprimer un document supprime ses chunks.
- `{{EMBEDDING_DIMENSION}}` est un marqueur remplacé à la migration (1024
  pour voyage-3.5). Ensuite, la dimension est **figée** : chaque script
  vérifie au démarrage que la colonne correspond à la config.
- Chaque migration passe dans une transaction, sur une connexion empruntée
  avec `pool.connect()`. `schema_migrations` évite de la rejouer.

> **À retenir**
> Deux tables liées par une cascade, des contraintes qui protègent la
> cohérence, une dimension figée dans la colonne une fois migrée.

**Questions**
1. Pourquoi la migration utilise-t-elle `pool.connect()` alors que le reste
   du code se contente de `pool.query()` ?

---

## Leçon 2 : quand ajouter un index vectoriel ?

Nous n'avons créé **aucun** index vectoriel. Sans index, Postgres calcule la
distance avec chaque chunk puis trie : un parcours séquentiel **exact**, au
coût linéaire.

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

- Jusqu'à 10 000 à 50 000 chunks environ : quelques millisecondes, l'index
  n'apporte rien. Au-delà de 100 000 environ, il se justifie.
- Les index de pgvector sont **approximatifs** : plus rapides, mais ils
  peuvent manquer un voisin (le **rappel** baisse).
- Un index sert **un opérateur** : celui-ci, uniquement les tris par `<=>`.

| Index | Principe | Pour | Contre |
| --- | --- | --- | --- |
| HNSW | graphe à plusieurs niveaux | excellent rappel, peut se créer sur une table vide | gourmand en mémoire, construction lente |
| IVFFlat | vecteurs rangés en listes (clusters) | construction rapide, compact | à créer *après* le chargement ; rappel sensible au réglage |

> **À retenir**
> Sous 100 000 chunks environ, pas d'index : la recherche est exacte et
> rapide. Un index échange de l'exactitude contre de la vitesse.

**Questions**
1. Que perd-on en ajoutant un index HNSW ?

---

## Leçon 3 : extraire le texte du PDF

Un PDF n'est qu'une suite d'**instructions de dessin**. pdf.js (via `unpdf`)
donne par page des fragments, avec `hasEOL` (fin de ligne) et une ordonnée.
Avec `extractText()`, les titres se collaient au paragraphe suivant :
l'espace entre paragraphes ne produit aucun caractère.

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

- Sur le fil rouge : lignes espacées de 15 points, paragraphes de 30. Médiane
  15, seuil 21 : au-delà, on insère une ligne vide.
- La médiane, pas la moyenne, que tireraient vers le haut les grands écarts
  qu'on cherche justement.
- Chaque page garde son **numéro**, pour pouvoir citer « page 3 ».

> **À retenir**
> On reconstruit les lignes avec `hasEOL`, les paragraphes avec l'interligne,
> et chaque page garde son numéro.

**Questions**
1. Un PDF scanné passe dans `extractPages`. Qu'obtient-on ?

---

## Leçon 4 : nettoyer le texte

La page 2 brute commence par « Guide RH interne — Version 2026 » et
« Page 2 / 6 », et contient des mots coupés (`conn-` / `exion`). Un pied de
page répété dans chaque chunk se retrouve dans tous les vecteurs, qui se
ressemblent alors artificiellement.

```ts
function signature(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#");
}
```

- « Page 2 / 6 » et « Page 3 / 6 » ont la même signature, `page # / #`.
- Une signature est supprimée si elle revient dans les 2 premières ou 2
  dernières lignes d'au moins la moitié des pages (et au moins 3). Sur le
  fil rouge, deux passent, sur 6 pages sur 6.
- Les ligatures (`ﬁ`) sont décomposées par NFKC, appliqué à elles seules ;
  les césures sont recollées ; les lignes regroupées en paragraphes.
- Tout `text/clean.ts` est **pur** : même entrée, même sortie.

> **À retenir**
> Normaliser les caractères, supprimer les lignes de marge répétées
> (comparées par signature), recoller les césures, reconstruire les
> paragraphes.

**Questions**
1. Une phrase d'introduction identique ouvre chaque chapitre, au milieu de la
   page. Sera-t-elle supprimée ?

---

## Leçon 5 : découper avec recouvrement

Un embedding a une taille fixe : sur un document entier, le sens devient
flou, et on veut retrouver **le passage** qui répond. On découpe donc en
chunks d'environ 500 tokens, sur une fin de paragraphe sinon de phrase, avec
15 % de recouvrement.

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

- Les unités sont des **phrases** (`Intl.Segmenter`). On coupe de préférence
  sur une fin de paragraphe atteinte à 60 % de la cible (300 tokens).
- Le recouvrement reprend des phrases entières jusqu'à 75 tokens : une idée à
  cheval sur deux chunks est présente des deux côtés.
- Les paragraphes sont recollés par-dessus les sauts de page, et chaque
  phrase garde ses pages : d'où un chunk « p. 1–2 ».
- Fil rouge (`rag:preview`) : 15 chunks, min 380 · moy 398 · max 501 tokens.

> **À retenir**
> On regroupe des phrases jusqu'à environ 500 tokens, en coupant de
> préférence sur une fin de paragraphe, avec 15 % de phrases reprises en
> tête du chunk suivant.

**Questions**
1. Pourquoi exiger un remplissage de 60 % avant d'accepter une fin de
   paragraphe comme coupure ?

---

## Leçon 6 : les embeddings

Il faut vectoriser chaque chunk via Voyage, sans se tromper d'encodage et
sans échouer au premier quota. Premier essai (`npm run rag:embed-check`) : le
passage sur les frais de connexion sort en tête avec **0,579**, devant la
mutuelle (0,435) et le VPN (0,315).

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

- **`input_type`** : `embedDocuments` envoie `"document"`, `embedQuery`
  `"query"`. Deux méthodes rendent l'erreur impossible.
- **Lots** de 128 textes au plus, envoyés l'un après l'autre.
- **Nouvelles tentatives** sur 429, 5xx et coupures réseau seulement : délai
  exponentiel (1 s, 2 s, 4 s… plafonné à 30 s), **jitter**, `Retry-After`
  respecté. Un 401 échoue tout de suite.
- **8 tentatives** : le compte de test était limité à 3 requêtes par minute,
  et avec 5, les attentes (environ 25 s) ne couvraient pas une minute.

> **À retenir**
> Même modèle et même dimension des deux côtés, toujours. Un client fiable
> groupe en lots et ne réessaie que l'erreur passagère.

**Questions**
1. À quoi sert le hasard dans le délai d'attente ?

---

## Leçon 7 : une ingestion idempotente et transactionnelle

`npm run ingest` sera relancé souvent : il doit être **idempotent** (relancer
ne change rien de plus), et ne jamais laisser un document à moitié écrit.

```
2 PDF trouvé(s) dans …/apps/api/data/pdfs/
+ guide-rh.pdf : nouveau · 6 pages · 15 chunks · 5802 tokens d'embedding · 2.0 s
…
= guide-rh.pdf : inchangé, ignoré                                   ← 2e lancement
…
+ guide-rh.pdf : modifié, réingéré · 7 pages · 17 chunks · 6554 tokens d'embedding · 1.5 s
```

- **Le sha256 décide**, pas la date : une copie change la date, pas le
  contenu. Fichier inchangé : aucun appel Voyage.
- **L'ordre est la clé** : découpage, puis embeddings (lents, réseau)
  **hors transaction**, puis écriture dans une transaction courte. Une
  transaction ouverte garde des verrous et une connexion.
- `replaceDocument` : `BEGIN` → `DELETE` (la cascade emporte les chunks) →
  `INSERT` → `COMMIT`, ou `ROLLBACK` en cas d'erreur. Aucun orphelin.
- Les logs ne contiennent que des métadonnées, jamais le contenu.

> **À retenir**
> L'empreinte décide. Le travail lent se fait hors transaction, les écritures
> dans une transaction courte, tout ou rien.

**Questions**
1. Pourquoi les embeddings sont-ils calculés en dehors de la transaction ?

---

## Leçon 8 : la recherche et l'opérateur `<=>`

La question est vectorisée avec `embedQuery`, puis Postgres renvoie les 5
chunks les plus proches, avec leur fichier et leurs pages.

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

| Opérateur | Distance | Formule |
| --- | --- | --- |
| `<->` | euclidienne (L2) | longueur du segment entre les deux points |
| `<=>` | **cosinus** | `1 − cos(angle)`, entre 0 et 2 |
| `<#>` | produit scalaire **négatif** | `−(a · b)` |

- Ce sont des **distances** : tri croissant. Le score `1 − distance` se lit
  directement : proche de 1, même sens.
- Les vecteurs de Voyage sont normalisés (norme 1,0000) : les trois
  opérateurs donnent alors le même classement.
- On trie sur l'expression, pas sur l'alias : c'est la forme qu'un futur index
  HNSW saura utiliser.
- `--explain` montre un `Seq Scan on chunks` en 0,772 ms. Sur le fil rouge,
  très répétitif, les cinq scores sont presque égaux (0,609 → 0,598).

> **À retenir**
> `<=>` est la distance cosinus, on trie par distance croissante, et le score
> vaut `1 − distance`. Sans index, c'est un `Seq Scan` exact.

**Questions**
1. Pourquoi la question est-elle vectorisée avec `embedQuery` et non
   `embedDocuments` ?

---

## Leçon 9 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| PDF scanné | Aucun chunk. Avertissement `⚠ … aucun texte extrait (PDF scanné ?)`, document enregistré sans chunk. |
| Quota dépassé (429) | Attente puis nouvelle tentative, jusqu'à 8 fois : `[voyage] HTTP 429 — tentative 2/9 dans 1000 ms`. |
| Quota toujours dépassé | `✗ … HTTP 429`, les autres fichiers continuent. En base : l'ancien sha256 et ses 15 chunks. Retenté au lancement suivant. |
| Clé refusée (401) | Un seul appel, aucune nouvelle tentative. |
| Dimension incohérente | Arrêt au démarrage ou à la réception des vecteurs, avant toute écriture. |
| Écriture qui échoue | `ROLLBACK` : l'ancienne version revient intacte. |
| Ctrl+C | Appel ou attente en cours annulé. Un fichier interrompu avant sa transaction n'a rien écrit. |

> **À retenir**
> Réessayer le passager, isoler l'échec d'un fichier, arrêter l'incohérent.
> Aucun document n'est jamais à moitié écrit.

**Questions**
1. Le document scanné est enregistré sans chunk. Pourquoi l'enregistrer
   plutôt que de l'ignorer ?

---

## Leçon 10 : synthèse

### Les idées à emporter

1. **Retrouver, c'est comparer des sens**, même sans mot commun.
2. **Le découpage fait la qualité** : nettoyer, couper sur le sens, recouvrir.
3. **Le pur à part** : `text/` se teste sans réseau ni base.
4. **Même modèle, même dimension** pour les passages et les questions.
5. **Fiabilité réseau** : lots, nouvelles tentatives sur l'erreur passagère.
6. **Idempotence et atomicité** : le sha256 décide, écritures tout ou rien.

### Vérifications manuelles

Depuis `chatbot/` :

```bash
npm run db:up                  # Container chatbot-postgres-1 Healthy
npm run db:migrate             # Migration appliquée : 001_init.sql, puis « Schéma déjà à jour »
npm run rag:preview -- mon.pdf --short   # chunks avec pages et tokens, en-têtes détectés
npm run rag:embed-check        # dimension 1024, frais de connexion en tête
npm run ingest                 # « nouveau », puis au 2e lancement « inchangé, ignoré »
npm run search -- "ta question" --sql --explain   # 5 résultats, un Seq Scan on chunks
EMBEDDING_API_KEY=x npm run rag:embed-check -w apps/api   # HTTP 401 immédiat
```

### Pour aller plus loin (non fait, volontairement)

Brancher la recherche sur `/chat` avec ses sources, recherche hybride
(`tsvector`), reranking, droits d'accès, index HNSW quand le volume l'exige.

---

## Corrigé des questions

**L0.1** Le passage parle de « frais de connexion », pas de « box » : les
mots-clés exigent les mêmes mots, les embeddings comparent le sens.

**L1.1** Une transaction est liée à une seule connexion, alors que le pool
peut en prêter une différente à chaque `pool.query()`.

**L2.1** L'exactitude : l'index peut manquer de vrais voisins. Il coûte aussi
de la mémoire et du temps de construction.

**L3.1** Des pages vides : un scan ne contient que des images. Il faudrait un
OCR avant l'extraction.

**L4.1** Non : on ne cherche les répétitions que dans les 2 premières et 2
dernières lignes non vides de chaque page.

**L5.1** Sans seuil, un titre ou une phrase courte déclencherait une coupure :
des chunks de quelques dizaines de tokens, trop pauvres pour être retrouvés.

**L6.1** À désynchroniser les clients : s'ils attendent tous le même délai
après un 429, ils reviennent ensemble et recréent le pic.

**L7.1** Les appels Voyage peuvent durer des minutes, et une transaction
ouverte garde verrous et connexion. Si Voyage échoue, rien n'a été touché.

**L8.1** Avec `input_type: "query"`, elle est encodée pour retrouver ce qui y
répond, et non des textes qui lui ressemblent.

**L9.1** Pour l'idempotence : sans empreinte en base, chaque `npm run ingest`
le retraiterait. Enregistré, il est ignoré tant qu'il ne change pas.
