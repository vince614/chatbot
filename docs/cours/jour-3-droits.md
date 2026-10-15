# Jour 3 · Cours 2 — Les droits d'accès

> [Sommaire](README.md) · Précédent : [Jour 3 · Cours 1 — La recherche hybride](jour-3-hybride.md) · [Approfondissement : le code](approfondissement/jour-3-droits.md)

> **Prérequis.** [La recherche hybride](jour-3-hybride.md) : `retrieve` en
> modes `vector`, `lexical` et `hybrid`.
>
> **Le fil rouge.** Bruno (groupe `tech`) demande « On travaille combien
> d'heures par semaine chez Lumen ? ». La réponse est dans
> `reglement-interieur.pdf`, réservé au groupe `rh`. Il doit obtenir « Je ne
> sais pas », sans qu'un seul passage du règlement quitte la base.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Où se place le contrôle d'accès dans un RAG ? |
| 1 | Comment représenter les droits, et que vaut « aucun droit » ? |
| 2 | Comment les droits arrivent-ils en base ? |
| 3 | Pourquoi sur les documents et pas sur les chunks ? |
| 4 | Pourquoi filtrer avant de classer ? |
| 5 | Et la recherche hybride ? |
| 6 | Le modèle peut-il aider à protéger ? |
| 7 | Comment l'API sait-elle qui demande ? |
| 8 | Que change l'interface ? |
| 9 | Que se passe-t-il quand ça se passe mal ? |
| 10 | Synthèse et corrigé |

---

## Leçon 0 : où se place le contrôle

```
X-User-Id ─► utilisateur ─► groupes ─► retrieve (WHERE allowed_groups && groupes) ─► prompt ─► modèle
                │ inconnu                       ▲
                ▼                               └ seul point de contrôle : rien d'interdit n'en sort
               401
```

Un passage interdit ne doit **jamais sortir de la base**. S'il n'en sort pas,
il ne peut fuiter ni par le prompt, ni par l'événement `sources`, ni par les
logs.

Ajouté : `003_acl.sql`, `data/pdfs/acl.json`, `data/users.json`, `applyAcl`,
le filtre `&&`, `userGroups` obligatoire dans `retrieve`, `X-User-Id` et le
401, le sélecteur d'utilisateur, `--user` dans `search`, `ask` et `eval:run`.

> **À retenir**
> Un seul point de contrôle, le plus tôt possible : la requête SQL.

---

## Leçon 1 : le modèle de droits

```sql
ALTER TABLE documents
    ADD COLUMN allowed_groups text[] NOT NULL DEFAULT '{}';

CREATE INDEX documents_allowed_groups_idx ON documents USING gin (allowed_groups);
```

- Un document a une liste de groupes, un utilisateur aussi. La règle « au
  moins un groupe en commun » est l'opérateur `&&` de Postgres :
  `{tech} && {rh}` vaut faux, `{tech} && {tech}` vaut vrai.
- **Refus par défaut** : `DEFAULT '{}'`. Juste après la migration, les deux
  documents valaient `{}` : invisibles jusqu'à l'ingestion. Un oubli cache,
  il ne publie jamais.
- L'index GIN est un index inversé « groupe → documents », comme pour le
  plein texte.

> **À retenir**
> Ne rien avoir, c'est ne rien voir.

---

## Leçon 2 : l'ACL et l'ingestion

`data/pdfs/acl.json` (ignoré par Git, comme les PDF) :

```json
{
  "reglement-interieur.pdf": ["rh"],
  "discordinvites.pdf": ["tech"]
}
```

- **Les droits sont réappliqués à chaque `ingest`**, PDF modifié ou non : le
  sha256 couvre le contenu, pas les droits. Une seule requête met à jour tous
  les documents ; un document absent de l'ACL reçoit `{}`.
- **ACL invalide ou absente : erreur, rien ne change.** Traiter un JSON cassé
  comme une ACL vide retirerait en silence tous les droits pour une virgule.
- Avertissements sans blocage : un PDF sans groupe (« visible par
  personne »), une entrée sans PDF (« faute de frappe ? »).
- Utilisateurs fictifs (`data/users.json`) : alice `rh`, bruno `tech`,
  chloe `rh` + `tech`.

> **À retenir**
> Les droits ont leur propre cycle de vie : ils ne dépendent pas du contenu.

**Question**
1. Pourquoi ne pas réappliquer les droits seulement aux PDF réingérés ?

---

## Leçon 3 : documents ou chunks ?

- **On partage un fichier, pas « les pages 3 à 4 »** : le document est
  l'unité réelle des droits ; les chunks sont un détail du découpage.
- **Une seule source de vérité** : recopiés sur chaque chunk, les droits
  pourraient diverger. La jointure `chunks → documents` existe déjà.
- **Changer un droit ne coûte qu'une ligne**, sans réembedding.

Un niveau plus fin devient nécessaire quand **une partie** d'un document a
une autre audience que le reste : une annexe « salaires », des paragraphes
classifiés, un fil de messages où chacun a ses droits. On découpe alors la
source selon les frontières de droits **avant** de découper en chunks.

---

## Leçon 4 : filtrer avant de classer

```sql
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE d.allowed_groups && $3::text[]
ORDER BY c.embedding <=> $1::vector
LIMIT $2
```

Bruno, « Combien de jours de congé paternité chez Lumen ? » (observé) :

```
Sans filtre, top 5     : reglement-#2  reglement-#1  reglement-#0  reglement-#5  reglement-#3
Filtre APRÈS (bruno)   : 0 résultat(s)
Filtre AVANT (bruno)   : 5 résultat(s) discordinv#6  discordinv#1  discordinv#3  discordinv#2  discordinv#5
```

- **Filtrer après coup** : si les k premiers sont tous interdits, il ne reste
  rien, même quand des passages autorisés existaient au rang 6. Plus il y a de
  documents interdits, plus c'est fréquent.
- Et le chunk interdit est déjà sorti de la base, à un log près de la fuite.
- **`userGroups` est obligatoire, sans défaut** : retirer les groupes d'un
  appel donne `error TS2345: … Property 'userGroups' is missing`. Oublier les
  droits est une erreur de compilation, pas une fuite. `[]` renvoie `[]`, sans
  appel Voyage.

> **À retenir**
> Le filtre est dans le WHERE : les k résultats sont les meilleurs **parmi les
> autorisés**.

**Question**
1. Un futur index HNSW change-t-il quelque chose ?

---

## Leçon 5 : l'hybride, deux branches filtrées

```
Hybride, lexical NON filtré : discordinv#2  discordinv#6  reglement-#2  discordinv#1  reglement-#1   ← fuite
Hybride, deux filtrés       : discordinv#2  discordinv#6  discordinv#1  discordinv#3  discordinv#5
```

La fusion RRF prend tout ce que chaque branche lui donne : une branche non
filtrée suffit à faire fuiter. Le filtre est donc dans **chaque** fonction SQL,
et le mode hybride n'a aucun SQL à lui.

---

## Leçon 6 : le modèle n'est pas un maillon

Une règle de prompt (« n'utilise que les documents autorisés ») serait
contournable par injection, probabiliste, et **trop tard** : le passage serait
déjà dans le prompt, envoyé au fournisseur du modèle et listé dans `sources`.
Le prompt RAG n'a pas changé : il ne reçoit que ce que `retrieve` a filtré.

> **À retenir**
> Le contrôle d'accès est déterministe et en amont ; le modèle ne voit que
> l'autorisé.

---

## Leçon 7 : l'identité dans l'API

```ts
const user = identifyUser(request, users);
if (!user) {
  // Ni l'en-tête reçu ni la raison exacte dans la réponse : absent et
  // inconnu sont indiscernables pour le client.
  request.log.warn("requête sans utilisateur identifié");
  return reply.code(401).send({ error: "Utilisateur non identifié." });
}
```

- **401 en premier** : avant la validation du corps, la recherche et le flux
  SSE.
- **Même réponse pour absent et inconnu** : l'API ne dit pas quels
  identifiants existent.
- **Logs** : `userId` et `chunks`, jamais les groupes ni le contenu.
- **`X-User-Id` est un remplaçant d'authentification** (`auth/fake-identity.ts`) :
  `curl -H "X-User-Id: chloe"` donne les droits de chloe à n'importe qui. En
  production : connexion via un fournisseur d'identité (OIDC), puis cookie de
  session `httpOnly` ou JWT dont le serveur vérifie signature, émetteur,
  audience et expiration ; les groupes viennent de cette preuve, jamais du
  client.

> **À retenir**
> Un filtre parfait sur la mauvaise identité laisse tout passer.

---

## Leçon 8 : l'interface

- Un sélecteur dans l'en-tête, alimenté par `GET /api/users` (identifiant et
  nom, pas les groupes). Sans utilisateur, la saisie est verrouillée.
- **Changer d'utilisateur vide la conversation.** Le client renvoie tout
  l'historique : la réponse obtenue par alice partirait au modèle dans la
  conversation de bruno. C'est une **fuite par l'historique**, sans qu'aucun
  chunk interdit ne passe par `retrieve`.
- Un flux en cours est annulé, et ses derniers morceaux ne réécrivent plus
  l'écran.

**Question**
1. Avec une vraie authentification, un client peut-il encore tricher avec
   l'historique ?

---

## Leçon 9 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| PDF absent de l'ACL | ingéré avec `{}`, visible par personne, avertissement |
| ACL au JSON cassé, groupe invalide (`"Tech Team"`) ou fichier absent | `ingest` s'arrête avant toute écriture, les droits en base restent intacts |
| PDF retiré de l'ACL | `🔒 … droits → personne` au prochain `ingest` |
| Utilisateur sans aucun groupe en commun | `retrieve` renvoie des chunks d'autres documents ou rien ; le modèle répond « Je ne sais pas » |
| `X-User-Id` absent, inconnu ou répété | 401, aucune recherche |
| `--user` oublié ou inconnu (`search`, `ask`, `eval:run`) | erreur avec la liste des identifiants |
| Runs comparés avec des utilisateurs différents | `eval:compare` avertit |

---

## Leçon 10 : synthèse

### Les idées à emporter

1. Un seul point de contrôle : la requête SQL. Rien d'interdit ne sort de la
   base.
2. Refus par défaut à chaque niveau : colonne, ACL, utilisateur, en-tête.
3. Les droits vivent sur les documents, et sont réappliqués à chaque
   ingestion.
4. Filtrer avant de classer, dans chaque branche de l'hybride.
5. Le compilateur empêche d'oublier les groupes.
6. Le modèle n'est pas un maillon du contrôle d'accès.
7. Changer d'utilisateur vide l'historique.

### Vérifications manuelles

ACL d'exemple : `reglement-interieur.pdf` → `rh` seulement,
`discordinvites.pdf` → `tech` seulement. Serveur lancé avec
`RAG_SEARCH_MODE=vector`, puis `lexical`, puis `hybrid` :

```bash
H='content-type: application/json'
Q1='{"messages":[{"role":"user","content":"On travaille combien d heures par semaine chez Lumen ?"}]}'
Q16='{"messages":[{"role":"user","content":"Dans quels contextes la CNIL est-elle mentionnée dans les documents ?"}]}'
curl -sN localhost:3000/api/chat -H "$H" -H 'X-User-Id: alice' -d "$Q1"   # V1
curl -sN localhost:3000/api/chat -H "$H" -H 'X-User-Id: bruno' -d "$Q1"   # V2
curl -sN localhost:3000/api/chat -H "$H" -H 'X-User-Id: bruno' -d "$Q16"  # V4
```

| Vérification | Résultat observé (identique dans les 3 modes) |
| --- | --- |
| V1 · alice, règlement autorisé | « 37 heures par semaine… [1] », citée : `reglement-interieur` p. 1 |
| V2 · bruno, règlement interdit | « Je ne sais pas… ne parlent ni de Lumen… » ; `sources` : uniquement `discordinvites` |
| V3 · les trois modes | V1, V2 et V4 donnent le même verdict en `vector`, `lexical` et `hybrid` |
| V4 · CNIL (dans les deux PDF), bruno | citées : `discordinvites` p. 2 et p. 4 seulement ; chloe, elle, cite aussi `reglement-interieur` p. 3 (en `vector` et `hybrid`) |
| V5 · `discordinvites.pdf` retiré de l'ACL, `npm run ingest` | `🔒 discordinvites.pdf : droits → personne` ; chloe ne cite plus que le règlement ; bruno : 0 source, « Je ne sais pas » |

Logs de la recherche pour V5 : `"userId":"bruno","chunks":0`, aucun groupe
ni contenu.

À refaire dans l'interface : choisis bruno, pose Q1 (« Je ne sais pas »),
passe sur alice (la conversation se vide), repose Q1 (réponse sourcée).
Remets l'ACL avec `cp apps/api/data/pdfs/acl.example.json apps/api/data/pdfs/acl.json && npm run ingest`.

### Pour aller plus loin (non fait, volontairement)

Vraie authentification (OIDC, session), Row-Level Security de Postgres,
droits au niveau des sections, conversation stockée côté serveur, suppression
en base des PDF retirés du dossier.

---

## Corrigé des questions

**L2.1** Retirer un groupe de l'ACL n'aurait aucun effet tant que le PDF ne
change pas : son sha256 resterait identique et il serait ignoré.

**L4.1** Oui : HNSW parcourt le graphe pour environ `ef_search` candidats, puis
applique le WHERE. Avec beaucoup de chunks interdits, on retombe sur le filtre
après coup. Parades : `hnsw.iterative_scan` (pgvector 0.8), index partiels par
groupe, `ef_search` plus grand.

**L8.1** Oui, il peut forger de faux messages « assistant ». Ce n'est pas une
fuite (il n'invente que ce qu'il sait), mais pour une confiance totale on
stocke la conversation côté serveur, liée à la session.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-3-droits.md).
