# Cours de la semaine

Chaque fonctionnalité du chatbot est accompagnée d'un cours. Ils se lisent
dans l'ordre : chacun part de l'état du code laissé par le précédent.

## Sommaire

| Jour | Cours | Sujet | Ce qu'on construit | Le code expliqué |
| --- | --- | --- | --- | --- |
| 1 | 1 | [Le flux d'un message](jour-1-flux-dun-message.md) | Monorepo, secret côté serveur, `LlmClient`, streaming SSE de Fastify jusqu'à React | [approfondissement](approfondissement/jour-1-flux-dun-message.md) |
| 1 | 2 | [Le tool use](jour-1-appel-doutils.md) | Format neutre, reconstitution d'un appel en streaming, registre d'outils, boucle | [approfondissement](approfondissement/jour-1-appel-doutils.md) |
| 2 | 1 | [L'ingestion d'un RAG](jour-2-ingestion.md) | Postgres + pgvector, extraction et découpage de PDF, embeddings Voyage, ingestion idempotente, recherche | [approfondissement](approfondissement/jour-2-ingestion.md) |
| 2 | 2 | [La réponse sourcée](jour-2-recherche-reponse.md) | `retrieve`, prompt RAG et injection, branchement sur `/chat`, événement `sources`, citations cliquables | [approfondissement](approfondissement/jour-2-recherche-reponse.md) |
| 2 | 3 | [Le jeu de test](jour-2-jeu-de-test.md) | 20 questions typées, runs comparables, notation manuelle, erreur de recherche ou de génération | [approfondissement](approfondissement/jour-2-jeu-de-test.md) |
| 3 | 1 | [La recherche hybride](jour-3-hybride.md) | Plein texte Postgres (`tsvector`, GIN), identifiants exacts, fusion RRF, `eval:compare` | [approfondissement](approfondissement/jour-3-hybride.md) |
| 3 | 2 | [Les droits d'accès](jour-3-droits.md) | ACL par document, refus par défaut, filtre `&&` avant le classement, `X-User-Id` et 401, fuite par l'historique | [approfondissement](approfondissement/jour-3-droits.md) |
| 4 | 1 | [L'évaluation automatique](jour-4-evaluation.md) | Graders par code, juge LLM et calibration, `npm run eval`, historique des scores | [approfondissement](approfondissement/jour-4-evaluation.md) |
| 4 | 2 | [Le serveur MCP](jour-4-serveur-mcp.md) | Package `@chatbot/rag` partagé, serveur stdio, identité fixée au lancement, `search_documents` et `list_documents`, Inspector, `.mcp.json` | [approfondissement](approfondissement/jour-4-serveur-mcp.md) |
| 4 | 3 | [L'API, client MCP](jour-4-client-mcp.md) | Un serveur MCP par utilisateur, outils MCP dans le registre, le modèle décide de chercher (`RAG_MODE`), résultats numérotés, panne du serveur, évaluation des deux modes | [approfondissement](approfondissement/jour-4-client-mcp.md) |
| 4 | 4 | [Le serveur MCP distant](jour-4-serveur-distant.md) | Transport Streamable HTTP, sessions, jeton par requête en temps constant, identité liée à la session, OAuth 2.1 (expliqué), client HTTP dans l'API | [approfondissement](approfondissement/jour-4-serveur-distant.md) |
| 4 | 5 | [La mémoire chiffrée](jour-4-memoire-chiffree.md) | IndexedDB sans bibliothèque, AES-GCM 256 (IV, AAD), clé non extractible, métadonnées chiffrées, sauvegarde différée, deux onglets, menaces (XSS, extension) | [approfondissement](approfondissement/jour-4-memoire-chiffree.md) |

## La trame commune

Tous les cours suivent la même structure, pour qu'on sache toujours où
chercher.

**Nom du fichier** : `jour-<N>-<sujet>.md`, dans ce dossier. L'ordre des
cours d'une même journée est donné par ce sommaire.

**En-tête**

```markdown
# Jour N · Cours K — Titre

> [Sommaire](README.md) · Précédent : [...](...) · Suivant : [...](...)

> **Prérequis.** Ce qu'il faut avoir suivi, et l'état du code au départ.
> (Le tout premier cours dit plutôt « À qui s'adresse ce cours ».)
>
> **Le fil rouge.** Un exemple concret, suivi du début à la fin du cours.
```

**Corps**

1. **Plan du cours** : un tableau `Leçon | Question à laquelle elle répond`.
2. **Leçon 0** : la vue d'ensemble. L'idée en une phrase, ce que nous avons
   ajouté (fichiers, commandes).
3. **Leçons 1 à n** : une leçon par idée importante, **courte**. Chacune :
   - pose le **problème** en deux ou trois phrases ;
   - montre **un seul extrait** du vrai code, celui qui porte l'idée (pas
     tout le fichier, pas chaque fonction) ;
   - en tire **trois à cinq points clés**, appuyés sur des valeurs réellement
     observées ;
   - se termine par un encadré `> **À retenir**` et une ou deux **Questions**.
   Les alternatives ne sont citées que si elles éclairent un choix.
4. **Avant-dernière leçon : « Quand ça se passe mal »** : un tableau
   cas → ce qui se passe.
5. **Dernière leçon : « Synthèse »**, dans cet ordre :
   - les idées à emporter ;
   - **Vérifications manuelles** : commandes à lancer et ce qu'on doit voir ;
   - **Pour aller plus loin (non fait, volontairement)**.
6. **Corrigé des questions**, regroupé à la fin, en une ou deux phrases par
   réponse.

Les cours sont volontairement courts : expliquer tout le code noie
l'essentiel.

## L'approfondissement

Chaque cours a un compagnon dans `approfondissement/`, du même nom, qui
explique le code **tel qu'il est aujourd'hui** dans le dépôt :

1. **Carte des fichiers** : fichier, rôle, leçon du cours concernée.
2. **Le parcours dans le code** : quelle fonction appelle quelle autre, du
   début à la fin du fil rouge.
3. **Un chapitre par fichier**, et dans chacun, par fonction importante :
   l'extrait exact, **ce que fait le code** étape par étape, puis **pourquoi**
   c'est écrit ainsi.
4. **Pour explorer toi-même** : où mettre un `console.log`, quoi lancer, quoi
   observer.

Pas de questions ni de corrigé : c'est un document de référence, à lire
fichier ouvert à côté. Le cours est lié à son approfondissement sous le titre
et à la fin.
