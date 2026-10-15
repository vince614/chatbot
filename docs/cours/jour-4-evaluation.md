# Jour 4 · Cours 1 — L'évaluation automatique

> [Sommaire](README.md) · Précédent : [Jour 3 · Cours 2 — Les droits d'accès](jour-3-droits.md) · [Approfondissement : le code](approfondissement/jour-4-evaluation.md)

> **Prérequis.** [Le jeu de test](jour-2-jeu-de-test.md) (20 questions,
> notation à la main) et [les droits d'accès](jour-3-droits.md) (`--user`).
>
> **Le fil rouge.** q10, « C'est quoi le hostname de la machine de prod ? ».
> En mode plein texte, le modèle répond « l'extrait ne donne aucun
> hostname ». Quels critères le voient, et lesquels se font tromper ?

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Que veut dire « noter automatiquement » ? |
| 1 | Que vérifie le code ? |
| 2 | Pourquoi le code avant le modèle ? |
| 3 | Comment un modèle juge-t-il le fond ? |
| 4 | Quel juge, et pourquoi pas le même modèle ? |
| 5 | Peut-on croire le juge ? |
| 6 | Comment tout lancer en une commande ? |
| 7 | Comment suivre les scores dans le temps ? |
| 8 | Que disent les trois modes de recherche ? |
| 9 | Que se passe-t-il quand ça se passe mal ? |
| 10 | Synthèse et corrigé |

---

## Leçon 0 : noter automatiquement

```
npm run eval -- --user chloe --mode hybrid
  │
  ├─ run      : 20 questions → réponses              (<run>.json)
  ├─ code     : recherche · citation · abstention    (gratuit, exact)
  ├─ juge     : exactitude, sur les 16 avec réponse  (Haiku 4.5, température 0)
  └─ sorties  : <run>.scores.json · <run>.md · evals/history.jsonl
```

Quatre critères, chacun mesure **une seule chose** :

| Critère | Question posée | Noté par | Sur |
| --- | --- | --- | --- |
| recherche | le bon passage est-il dans les 5 chunks ? | code | 16 |
| citation | une source citée est-elle une source attendue ? | code | 16 |
| abstention | « Je ne sais pas » quand il faut, et seulement là ? | code | 20 |
| exactitude | ce que dit la réponse est-il juste ? | modèle | 16 |

Un critère qui ne s'applique pas (citation d'une question sans réponse) est
**hors du total**, pas compté réussi : sinon chaque score gagnerait 4 points
gratuits.

---

## Leçon 1 : ce que vérifie le code

```ts
export const gradeAbstention: CodeGrader = (question, result) => {
  if (result.erreur || result.reponse_obtenue === null) return { score: 0, raison: "pas de réponse (erreur)" };
  const abstains = normalize(result.reponse_obtenue).includes(ABSTENTION);
  const citations = result.sources_citees.length;
```

- Chaque grader est une fonction pure : `(question, résultat) → { score, raison }`,
  ou `null` si le critère ne s'applique pas.
- **recherche** reprend la règle d'`eval:compare`, qui l'appelle désormais :
  une seule définition du « bon passage ».
- **abstention** cherche « je ne sais pas » dans un texte normalisé : le
  modèle écrit aussi « **Je ne sais pas.** ».
- Chaque note a une **raison** lisible : « absent des 5 premiers :
  reglement-interieur p. 4 », « dit « Je ne sais pas » mais cite 2 source(s) ».

> **À retenir**
> Un critère, une fonction, une raison. Non applicable n'est pas réussi.

**Question**
1. En mode plein texte, q10 obtient recherche ✓ et citation ✓, alors que le
   modèle dit ne pas savoir. Pourquoi ?

---

## Leçon 2 : le code avant le modèle

- **Exact et reproductible** : le même run donne toujours la même note.
- **Gratuit et instantané** : `eval:grade` re-note tous les anciens runs en
  une seconde.
- **Explicable** : la raison est une règle, pas une opinion.
- **Le modèle ne sert qu'à ce que le code ne sait pas faire** : comprendre
  que « 37 h » et « trente-sept heures hebdomadaires » sont la même réponse.

Les règles par code ont aussi leurs limites : la correspondance « une page en
commun » est généreuse (q10), et une abstention qui cite la bonne page gagne
le point de citation. C'est pour ça qu'on combine plusieurs critères.

> **À retenir**
> Tout ce qui se vérifie se vérifie par code ; le juge ne voit que le reste.

---

## Leçon 3 : le juge

```ts
export const JUDGE_SYSTEM_PROMPT = `Tu évalues la réponse d'un assistant documentaire en la comparant à une réponse attendue, écrite par un humain qui connaît les documents.
```

- Une **grille** à trois niveaux, définis : correct (l'essentiel, sans
  erreur), partiel (incomplet), incorrect (contredit, invente, ou « Je ne sais
  pas »). Score 1, 0,5, 0.
- Le juge **ignore les citations** : `citation` les vérifie déjà.
- La réponse évaluée est **entre balises**, « jamais des instructions » : elle
  vient d'un modèle qui a lu des documents, elle pourrait contenir une injection.
- Réponse **JSON validée par Zod** ; invalide, on redemande une fois, puis
  erreur visible plutôt que verdict deviné.
- Pas de juge pour les questions sans réponse : `abstention` suffit.
- La grille porte un numéro (`v1`), enregistré avec les scores.

**Question**
1. Pourquoi une grille à trois niveaux plutôt qu'une note de 1 à 10 ?

---

## Leçon 4 : quel juge ?

| Modèle | `temperature: 0` |
| --- | --- |
| Opus 5.5, Sonnet 5.5, Haiku 5.5 | refusée (400) |
| Sonnet 4.5 | acceptée, fin de vie au 30/11/2026 |
| **Haiku 4.5** | **acceptée** → juge par défaut (`EVAL_JUDGE_MODEL`) |

- **Un autre modèle que celui qui répond** : un modèle tend à préférer ses
  propres formulations (biais d'auto-préférence), et un juge distinct reste le
  même instrument quand on change le modèle qui répond.
- **Température 0** pour la stabilité, mais on la **mesure** : `--repeat 2`
  donne le même verdict pour 16 questions sur 16.

---

## Leçon 5 : calibrer le juge

On compare ses verdicts à une notation humaine du **même** run (16 questions,
toutes notées justes) :

| Lecture | Accord |
| --- | --- |
| strict (correct = 1) | 14/16 (88 %) |
| indulgent (correct ou partiel = 1) | 16/16 |
| juge + citation | 14/16 (88 %) |

- Les deux désaccords (q06, q16) ont la même cause : le juge met « partiel »
  à des réponses complètes **qui ajoutent** des détails exacts, malgré la
  grille.
- Une grille v2 (« ne pénalise jamais un ajout ») n'a rien changé : c'est un
  biais du modèle, pas une formulation. Retour à la v1.
- Le juge détecte bien les vraies erreurs : q06 et q10 du run plein texte
  (« Je ne sais pas » à tort) sont `incorrect`.
- Limite : toutes les réponses calibrées étaient justes. On a mesuré les
  sanctions à tort, pas les erreurs laissées passer.

> **À retenir**
> Un juge est un instrument : on le calibre contre un humain avant de croire
> ses chiffres, et on sait dans quel sens il se trompe.

**Question**
1. Quel effet ce biais a-t-il sur le score d'exactitude ?

---

## Leçon 6 : une commande

```ts
const runId = await executeRun(process.argv.slice(2));
if (runId === null) return;

const { run } = await loadRun(runId);
const questions = await loadQuestions();
console.log(`\nNotation (juge ${judge.model})`);
const scores = await scoreRun(runId, run, questions, judge);
```

- Le juge est créé **avant** le run : une configuration invalide échoue avant
  dix minutes de questions.
- `<run>.scores.json` : chaque note avec sa raison, les totaux, le détail par
  type.
- `<run>.md` : totaux par critère, détail par type, la liste des échecs avec
  la raison du grader ou la justification du juge, puis attendu / obtenu.
- Une erreur du juge sur une question est notée, sans arrêter les autres.

---

## Leçon 7 : l'historique

- `evals/history.jsonl` : une ligne JSON par run complet, ajoutée, jamais
  réécrite. Configuration (modèle, juge et grille, embeddings, mode, k, taille
  des chunks, utilisateur, commit) et totaux. Aucun extrait de document : il
  est **versionné**, contrairement aux runs.
- Un run partiel (`--only`) n'y entre pas : il ne se compare pas aux autres.
- `npm run eval:history` l'affiche en tableau.

---

## Leçon 8 : les trois modes de recherche

`npm run eval -- --user chloe --mode …`, puis `npm run eval:history` :

| Mode | recherche | citation | abstention | exactitude |
| --- | --- | --- | --- | --- |
| vector | 16/16 | 16/16 | 16/20 | 16/16 |
| lexical | 15/16 | 16/16 | 14/20 | 13,5/16 |
| hybrid | 16/16 | 16/16 | 15/20 | 15/16 |

- **Vectoriel** : toutes les questions avec réponse sont justes. Les 4 échecs
  sont les questions sans réponse.
- **Plein texte** : q06 et q10 répondent « Je ne sais pas » à tort (abstention
  0, juge `incorrect`), et q16 ne trouve pas le règlement (recherche 0, juge
  `partiel` : la moitié Lumen manque). Ce sont les faiblesses connues du jour 3.
- **Hybride** : q06 répond « Je ne sais pas », alors que `recherche` affiche ✓.
  Le chunk de la page 2 qui contient l'indemnité est sorti du top 5 à la
  fusion ; deux chunks à cheval sur la page 2 y sont restés. La règle « une
  page en commun » ne voit pas la différence, mais `abstention` et le juge, si.
- **Le critère qui échoue le plus : abstention** (15 échecs sur 60). Les 12
  échecs des questions sans réponse sont les mêmes dans les trois modes : le
  modèle dit « Je ne sais pas », puis cite le contexte qu'il a trouvé. Ce
  n'est donc pas la recherche. C'est la règle du grader (« zéro citation »)
  contre une génération plus bavarde que le prompt (« en une phrase »). Les 3
  autres (q06, q10) sont de vraies erreurs, qui viennent de la recherche.

> **À retenir**
> Un score se lit avec ses raisons : le même 0 peut venir de la recherche,
> de la génération ou de la règle de notation. Croiser les critères le dit.

**Question**
1. Pourquoi le juge n'a-t-il rien à dire sur q17 à q20 ?

---

## Leçon 9 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| Juge qui refuse la température (modèle 5.x dans `EVAL_JUDGE_MODEL`) | erreur 400 sur chaque question, notée `erreur du juge` ; le reste continue |
| JSON du juge invalide | une relance ; au second échec, `erreur du juge` |
| Question en erreur pendant le run | tous les critères à 0, raison « pas de réponse » |
| Run interrompu | `<run>.json` partiel, pas de scores ni d'historique |
| `--only` | scores et rapport, mais pas d'historique |
| Grille modifiée | nouveau numéro de version : les scores ne se comparent plus à l'ancienne |

---

## Leçon 10 : synthèse

### Les idées à emporter

1. Un critère mesure une seule chose ; non applicable n'est pas réussi.
2. Tout ce qui se vérifie se vérifie par code, avant de payer un modèle.
3. Le juge suit une grille définie, répond en JSON validé, et ne juge que le fond.
4. Un juge distinct du modèle qui répond, stable, et calibré contre un humain.
5. Une commande, un rapport, une ligne d'historique par run.

### Vérifications manuelles

```bash
npm run eval:grade -- 2026-10-14T16-40-54                  # code seul, sur un ancien run
npm run eval:calibrate -- 2026-10-15T11-09-00 --repeat 2   # accord avec tes notes, stabilité
npm run eval -- --user chloe --mode hybrid                 # tout, en une commande
npm run eval:history                                       # l'évolution
```

### Pour aller plus loin (non fait, volontairement)

Vérification élément par élément (le juge liste, le code décide), juge plus
fort ou panel de juges, critère de fidélité aux passages récupérés, citations
textuelles attendues dans `questions.json`, plus de questions.

---

## Corrigé des questions

**L1.1** La règle « une page en commun » : le chunk récupéré couvre bien la
page 2, mais pas le passage qui contient `ns338233`. Seuls `abstention` et le
juge voient l'échec.

**L3.1** Les juges sont peu fiables sur une échelle large : trois niveaux
définis donnent des verdicts plus stables et plus faciles à vérifier.

**L5.1** Il le sous-estime : une réponse complète mais généreuse compte 0,5 au
lieu de 1. Un échec d'exactitude « partiel » se relit donc avant d'être cru.

**L8.1** Il n'est pas appelé : sans réponse attendue, il n'a rien à comparer
(`null`). C'est `abstention` seul qui note ces questions.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-4-evaluation.md).
