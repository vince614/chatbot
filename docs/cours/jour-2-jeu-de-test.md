# Jour 2 · Cours 3 — Mesurer la qualité avec un jeu de test

> [Sommaire](README.md) · Précédent : [Jour 2 · Cours 2 — La réponse sourcée](jour-2-recherche-reponse.md) · Suivant : [Jour 3 · Cours 1 — La recherche hybride](jour-3-hybride.md) · [Approfondissement : le code](approfondissement/jour-2-jeu-de-test.md)

> **Prérequis.** [La réponse sourcée](jour-2-recherche-reponse.md) : le chat
> cherche, répond à partir des documents et cite ses sources.
>
> **Le fil rouge.** q13, « Lequel des deux cofondateurs gère les sauvegardes
> et les déploiements ? », dont la réponse (Vince) n'existe que dans un
> **tableau** de `discordinvites.pdf`, page 1.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Pourquoi un jeu de test ? |
| 1 | Comment écrire les questions ? |
| 2 | Comment rejouer les questions de façon comparable ? |
| 3 | Comment noter, et comment lire un échec ? |
| 4 | Que se passe-t-il quand ça se passe mal ? |
| 5 | Synthèse et corrigé |

---

## Leçon 0 : pourquoi un jeu de test ?

Sans jeu de test, on juge un RAG sur deux ou trois questions dont on se
souvient. Un **jeu de test** fixe des questions **et leurs réponses
attendues**, pour mesurer avant et après chaque changement (découpage,
modèle, prompt) et comparer des chiffres plutôt que des impressions.

```
evals/questions.json ──► npm run eval:run ──► runs/<date>.json   (ce qui s'est passé)
                                          ├─► runs/<date>.md     (à lire)
                                          └─► runs/<date>.notes.json  (à remplir)
                                                         │
                                         npm run eval:score -- <date>
```

> **À retenir**
> Mesurer, c'est comparer des runs. Un run ne vaut que si l'on sait avec
> quels réglages il a été produit.

---

## Leçon 1 : les questions

```json
{
  "id": "q13",
  "type": "tableau",
  "question": "Lequel des deux cofondateurs gère les sauvegardes et les déploiements ?",
  "reponse_attendue": "Vince (Vincent Vfy), dont le périmètre couvre le backend, l'API, la base de données et l'infrastructure.",
  "sources_attendues": [{ "fichier": "discordinvites.pdf", "pages": [1] }],
  "avec_reponse": true
}
```

- **Écrites depuis les PDF, pas depuis les chunks.** Les pages sont stables,
  les chunks non : sinon le jeu de test hériterait du découpage qu'il doit
  juger.
- **Des types de questions**, pour diagnostiquer. « 0/3 sur les identifiants »
  dit quoi corriger ; « 15/20 » ne dit rien.
- **Formulées comme un utilisateur** (« je bosse depuis mon salon »).
  Recopier le document gonflerait les scores.
- **4 questions sans réponse**, dont 3 piégeuses (le document parle du sujet
  sans donner la réponse) : elles mesurent la capacité à dire « Je ne sais
  pas ».

> **À retenir**
> Des questions écrites depuis la source, typées, formulées comme un
> utilisateur, avec des pièges sans réponse.

**Question**
1. Pourquoi ne pas écrire les questions à partir des chunks en base ?

---

## Leçon 2 : rejouer les questions

```ts
const chunks = await retrieve(question.question, { k: DEFAULT_K });
const prompt = buildRagPrompt(question.question, chunks);
for await (const event of llm.streamChat({
  system: prompt.system,
  messages: [{ role: "user", content: prompt.user }],
  effort: EFFORT,
})) { … }
```

- **Les mêmes fonctions que `/chat`**, sans HTTP, sans historique et sans
  outils.
- **Pas de température 0** : `claude-opus-5-5` la refuse (erreur 400).
  L'**effort est épinglé** à `medium`, la valeur que `/chat` utilise par
  défaut. Deux runs peuvent donc différer légèrement ; compare deux runs
  consécutifs pour mesurer ce bruit.
- **La configuration est enregistrée** avec le run : modèle, effort,
  embeddings, découpage, k, commit Git, empreintes du prompt et des
  questions, documents en base. Si l'un de ces éléments diffère, les deux
  runs ne se comparent pas directement.
- **Séquentiel**, à cause du quota Voyage. Les durées incluent les attentes de quota : ne les compare qu'entre runs faits dans les mêmes conditions. Une question en erreur
  est notée sans arrêter le run, et le fichier est écrit après chaque
  question.

> **À retenir**
> Même chaîne que la production, réglages épinglés et enregistrés, et les
> erreurs notées plutôt que fatales.

**Question**
1. Pourquoi enregistrer le commit et les empreintes, et pas seulement le modèle ?

---

## Leçon 3 : noter et lire un échec

Deux notes par question, saisies à la main dans `<run>.notes.json` :
- **recherche** : 1 si le bon passage figure dans les 5 chunks (pour une
  question sans réponse, il n'y a rien à trouver : 1) ;
- **réponse** : 1 si la réponse est juste et cite la bonne source (pour une
  question sans réponse : 1 si « Je ne sais pas »).

**Lire un échec**, c'est croiser les deux notes :

```ts
if (recherche === 0 && reponse === 0) return "erreur de RECHERCHE";
if (recherche === 1 && reponse === 0) return "erreur de GÉNÉRATION";
```

| recherche | réponse | Diagnostic | Ce qu'il faut corriger |
| --- | --- | --- | --- |
| 0 | 0 | **recherche** : le modèle n'a jamais vu le bon passage | découpage, extraction (tableaux), k, recherche hybride pour les identifiants, reranking |
| 1 | 0 | **génération** : le passage était là, la réponse est fausse | prompt (règles, format de citation), modèle, effort |
| 0 | 1 | réponse juste sans le bon passage | à surveiller : un autre passage contenait l'info, ou c'est de la chance |

Corriger le prompt quand c'est la recherche qui échoue ne sert à rien : le
modèle ne peut pas citer ce qu'il n'a pas reçu. C'est pour cela qu'on note
la recherche séparément.

> **À retenir**
> Deux notes séparées disent **où** est le problème : avant le modèle
> (recherche) ou dans le modèle (génération).

**Question**
1. q13 obtient recherche 0, réponse 0. Que regardes-tu en premier ?

---

## Leçon 4 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| Quota Voyage dépassé | le client réessaie (jusqu'à ~2 min) ; le run est plus lent, et la durée de la question inclut l'attente (premier run : une question sur trois autour de 60 s au lieu de 3 à 6 s) |
| Clé refusée, base arrêtée | chaque question est notée `erreur`, le run se termine, et l'erreur apparaît dans le rapport |
| Run interrompu (Ctrl+C) | le JSON contient les questions déjà faites, mais le rapport n'est pas généré |
| Rapport régénéré | `<run>.notes.json` n'est jamais écrasé : tes notes sont conservées |
| Question non notée | `eval:score` la signale et la compte comme non réussie |

---

## Leçon 5 : synthèse

### Les idées à emporter

1. Un jeu de test transforme des impressions en chiffres comparables.
2. Les questions s'écrivent depuis la source, avec des pièges sans réponse.
3. Un run enregistre ses réglages ; sans eux, il ne se compare à rien.
4. Le modèle actuel n'a pas de température : on épingle l'effort, et on mesure le bruit.
5. Deux notes séparées distinguent erreur de recherche et erreur de génération.

### Vérifications manuelles

```bash
npm run eval:run                                  # ~5 à 10 min avec le quota Voyage
#   → apps/api/evals/runs/<date>.json, .md, .notes.json
# lire le .md, remplir le .notes.json (0 ou 1)
npm run eval:score -- <date>                      # totaux, détail par type, échecs diagnostiqués
npm run eval:run -- --only q10,q13                # rejouer quelques questions
```

### Pour aller plus loin (non fait, volontairement)

Notation automatique (par code ou par un modèle juge), plusieurs passages par
question pour mesurer le bruit, un jeu plus large pour comparer des réglages
proches.

---

## Corrigé des questions

**L1.1** Le jeu de test hériterait des défauts du découpage actuel : il ne
pourrait plus juger un autre découpage. Les pages, elles, ne changent pas.

**L2.1** Le prompt, le code ou les documents peuvent changer sans que le
modèle change. Les empreintes et le commit disent si deux runs ont été
produits dans les mêmes conditions.

**L3.1** Les chunks récupérés : la page 1 est-elle dans la liste ? Si oui,
c'est l'extraction du tableau qui a brouillé le texte ; si non, c'est le
classement de la recherche. Le prompt n'y est pour rien.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-2-jeu-de-test.md).
