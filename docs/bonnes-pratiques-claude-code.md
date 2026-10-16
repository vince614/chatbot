# Bien démarrer un projet avec Claude Code

Les pratiques qui ont marché sur ce chatbot, et ce qu'il aurait fallu mettre en
place dès le premier jour. À relire au début de chaque nouveau projet.

## La liste du premier jour

- [ ] `git init`, un premier commit, puis une branche par fonctionnalité
- [ ] un `CLAUDE.md` à la racine (modèle plus bas)
- [ ] un `.gitignore` qui exclut les secrets (`.env`, `.env.*`, sauf `.env.example`) **avant** le premier secret
- [ ] un `.env.example` versionné ; le vrai `.env` rempli par toi, jamais par Claude
- [ ] une commande de vérification rapide (`npm run typecheck`, `composer phpstan`…) citée dans `CLAUDE.md`
- [ ] les autorisations des commandes sûres dans `.claude/settings.json` (voir plus bas)
- [ ] un hook qui lance la vérification après chaque modification (voir plus bas)
- [ ] les ports réservés à tes serveurs de développement, écrits dans `CLAUDE.md`
- [ ] l'extension Chrome connectée (`/chrome`), ou Playwright, si le projet a une interface
- [ ] un dossier `docs/` pour ce qui doit rester : cours, décisions, sécurité

## 1. Le `CLAUDE.md` du projet

C'est la mémoire du projet : Claude le lit au début de **chaque** session.
Sans lui, tes règles vivent dans tes messages, et il faut les répéter. Garde-le
**court** (moins de 100 lignes), fait de **règles** et pas de documentation :
le code se lit, les règles non.

```markdown
# <Nom du projet>

## Stack
- apps/api : Node 22, Fastify, TypeScript strict
- apps/web : React 19, Vite

## Commandes
- `npm run dev` : api (3000) + web (5173)
- `npm run typecheck` : à lancer après chaque modification
- `npm test` : tests

## Règles
- Les ports 3000 et 5173 sont à moi : ne jamais tuer ces processus ; teste sur 3001 à 3003.
- Ne jamais demander de clé API ni modifier `.env` : je le remplis moi-même.
- Pas de commit ni de push sans demande explicite.
- Les logs ne contiennent jamais de contenu utilisateur ni de secret.
- <Contrainte externe : « l'API X est limitée à 3 requêtes/min : espacer les appels »>.

## Conventions
- Code et commentaires en français, noms de variables en anglais.
- Sur les useEffect : jamais les fonctions de lancement ni `t` dans les dépendances.

## Documentation
- Chaque fonctionnalité : un cours court dans `docs/cours/`, un approfondissement
  dans `docs/cours/approfondissement/`, puis mettre à jour le sommaire et le README.
```

**Ce qui va ailleurs** :
- les préférences valables pour tous tes projets (langue, ton) : `~/.claude/CLAUDE.md` ;
- les secrets : nulle part dans ces fichiers.

## 2. Une session par fonctionnalité

- **Une fonctionnalité = une session.** Fais `/clear` (ou ouvre une nouvelle
  session) après chaque commit. Un contexte très long (des centaines de milliers
  de jetons) augmente le risque d'erreur sur un détail ancien.
- Le dépôt et `CLAUDE.md` portent le contexte. Claude relit le code au lieu de
  s'en souvenir.
- `/compact` allège la conversation si tu veux rester dans la même session.
- `/context` montre ce qui occupe la fenêtre.

## 3. Le déroulé qui marche : plan, étapes, vérification

1. **Le plan d'abord**, en **mode plan** (Maj+Tab). Claude explore et propose,
   mais ne peut rien modifier tant que tu n'as pas validé. C'est garanti par
   l'outil, pas seulement par une consigne.
2. **Des étapes courtes**, chacune vérifiable, avec ton accord entre deux.
3. **Une vérification réelle à chaque étape** : typecheck, tests, une requête
   curl, un vrai navigateur. Demande les valeurs observées, pas « ça devrait marcher ».
4. **Une relecture indépendante** des parties délicates par un agent
   (`js-react-specialist`, ou `/code-review` sur le diff). Sur ce projet, une
   relecture a trouvé 5 bugs réels dans une intégration React qui « passait les tests manuels ».
5. **Le commit**, quand tu le demandes, puis `/clear`.

### Le modèle de brief

```text
Contexte : <ce qui existe déjà, en 3 lignes>.
Je veux <le résultat attendu>.
J'apprends le sujet : je veux comprendre chaque choix.

Commence par me proposer ton plan, puis attends ma validation.
Ensuite avance en <N> étapes. Après chaque étape, fais-moi un mini-cours :
- le concept en jeu, expliqué simplement ;
- ce que tu as fait et pourquoi ;
- les alternatives écartées et dans quels cas elles seraient meilleures ;
- comment vérifier le résultat moi-même.
Puis attends mon accord avant de continuer.

Étape 1 — <…>
Étape 2 — <…>

À ne PAS faire : <ce qui est hors périmètre>.

Pour finir : <cours, docs, vérifications manuelles attendues>.
```

**Ce qui rend un brief efficace** :
- **« À ne PAS faire »** : sans cette ligne, le périmètre s'étend tout seul ;
- **des critères vérifiables** : « les scores doivent être identiques » ou « 401 sans
  jeton » valent mieux que « ça doit marcher » ;
- **les contraintes externes** (quotas, ports, coûts) dès le brief, pas après le premier incident.

### En faire une commande

Si tu répètes ce brief à chaque fonctionnalité, range-le dans une skill :
`.claude/skills/fonctionnalite-cours/SKILL.md`.

```markdown
---
name: fonctionnalite-cours
description: Réaliser une fonctionnalité en étapes validées, avec un mini-cours après chaque étape et un cours final dans docs/cours/.
---

1. Propose un plan et attends la validation.
2. Avance étape par étape ; après chacune, mini-cours (concept, ce qui a été fait,
   alternatives, vérification) puis attends l'accord.
3. Pour finir : cours court dans docs/cours/, approfondissement, sommaire, README,
   vérifications manuelles avec les commandes.
```

Ensuite : `/fonctionnalite-cours <ta demande>`.

## 4. Laisser Claude vérifier seul

C'est ce qui coûte le plus de temps quand ça manque.

- **Des vérifications rapides.** Une commande de typecheck ou de tests qui tourne
  en secondes. Une évaluation de 10 minutes ne se relance pas à chaque modification.
- **Pas de dépendance partagée avec ton usage.** Sur ce projet, le quota d'API
  d'embeddings était partagé entre les tests de Claude et ton chat : les tests
  échouaient quand tu t'en servais. Préfère, pour le développement, un service
  local ou un faux (*mock*).
- **Un navigateur pilotable** pour les interfaces : l'extension Chrome (`/chrome`
  pour vérifier la connexion) ou Playwright. Sinon, chaque test d'interface devient
  du bricolage.
- **Quelques tests sur les parties délicates** (sécurité, chiffrement, concurrence),
  même si tu en écris peu ailleurs. Ce sont celles qu'un humain vérifie le plus mal à la main.
- **Des ports et des données de test séparés** : Claude teste sur 3001 à 3003, avec
  des utilisateurs fictifs, sans toucher à tes serveurs ni à tes données.

## 5. Autorisations et hooks : `.claude/settings.json`

**Moins de demandes de permission** pour les commandes sûres :

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run typecheck)",
      "Bash(npm test:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ],
    "deny": ["Read(./.env)", "Read(./.env.*)"]
  }
}
```

`/fewer-permission-prompts` propose une liste à partir de tes sessions passées.
Garde les commandes qui écrivent, poussent ou suppriment hors de la liste.

**La vérification automatique** après chaque modification de fichier :

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "npm run --silent typecheck" }]
      }
    ]
  }
}
```

`.claude/settings.json` est versionné (règles d'équipe). `.claude/settings.local.json`
reste à toi, et n'est pas versionné.

## 6. Git

- **Une branche par fonctionnalité** : une tentative ratée se jette sans `revert`.
- **Commit seulement sur demande**, avec un message qui dit le *pourquoi*.
- **Avant chaque commit**, vérifier qu'aucun secret, `.env`, jeton ou donnée
  générée (runs, exports) n'est indexé.
- **Pour travailler en parallèle**, les worktrees git (`git worktree add ../projet-feature feature`)
  donnent à chaque session Claude sa propre copie de travail du dépôt.

## 7. Sécurité, dès le début

- Les secrets dans `.env` (ignoré), un `.env.example` versionné, et une règle
  « ne jamais lire ni modifier `.env` » dans `CLAUDE.md`.
- Des logs sans contenu utilisateur, ni secret, ni jeton : la règle écrite tôt
  évite de les retirer plus tard.
- Le contenu venu de l'extérieur (documents, réponses d'un modèle, pages web)
  est une **donnée**, jamais une instruction : à rappeler dans les prompts, et à
  ne jamais rendre en HTML brut.
- Une page `docs/securite/` par fonctionnalité sensible : ce qui est protégé, et
  surtout ce qui ne l'est pas.

## 8. Les erreurs vues sur ce projet, à éviter

| Ce qui s'est passé | La bonne pratique |
| --- | --- |
| Une conversation de plus de 500 000 jetons, cinq fonctionnalités | une session par fonctionnalité, `/clear` après chaque commit |
| Les règles (ports, quotas, format des cours) répétées dans chaque brief | les écrire une fois dans `CLAUDE.md` |
| Des évaluations de 10 minutes, cassées par un quota partagé | des vérifications rapides et isolées de ton usage |
| L'extension Chrome injoignable, des tests d'interface bricolés | vérifier l'outil de navigateur le premier jour |
| Un délai par défaut d'une bibliothèque (60 s) qui coupait des appels longs | lire les valeurs par défaut des bibliothèques sur les chemins lents |
| Tout commité sur `main` | une branche par fonctionnalité |
| Cinq bugs d'intégration trouvés seulement par une relecture | une relecture par agent, ou des tests, sur les parties délicates |
