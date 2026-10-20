# Chatbot

Mini-projet d'apprentissage : un chatbot React + Node, organisé en monorepo
npm workspaces.

- `apps/api` : backend Node 20+ / Fastify / TypeScript strict
- `apps/web` : frontend React / Vite / TypeScript strict
- `apps/mcp-server` : le RAG exposé comme serveur MCP (stdio ou Streamable HTTP) : outils, ressources, prompts
- `apps/auth-server` : mini serveur d'autorisation OAuth (jetons JWT signés, JWKS)
- `packages/rag` : le RAG partagé (`@chatbot/rag`) : ingestion, base,
  embeddings, recherche, droits d'accès

Fonctionnalités en place :

- **chat en streaming** (SSE) avec un modèle Claude ;
- **tool use** : le modèle peut appeler des outils côté serveur
  (`get_current_datetime`, `calculate`) ;
- **journal d'événements** dans l'interface : actions, requêtes HTTP,
  événements SSE, échanges avec le modèle ;
- **ingestion RAG** : PDF → chunks → embeddings Voyage AI → Postgres +
  pgvector ;
- **réponses sourcées** : le chat répond uniquement à partir des passages
  retrouvés (« Je ne sais pas » sinon) et cite ses sources `[1]`, `[2]` ;
  l'interface affiche les sources citées, dépliables, et les pastilles
  renvoient à l'extrait ;
- **serveur MCP** : `search_documents` et `list_documents`, utilisables par
  Claude Code ou tout client MCP, avec les droits d'un utilisateur fixé au
  lancement ;
- **l'API, client MCP** : par défaut (`RAG_MODE=tool`), c'est le modèle qui
  décide d'appeler `search_documents`, à travers un serveur MCP lancé pour
  chaque utilisateur ; `RAG_MODE=always` cherche avant chaque message ;
- **historique chiffré dans le navigateur** : plusieurs conversations par
  utilisateur, conservées dans IndexedDB et chiffrées en AES-GCM 256 avec
  une clé non extractible (Web Crypto natif) ; rien n'est stocké côté
  serveur ; panneau latéral (nouvelle, sélection, suppression, « Tout
  effacer ») ;
- **serveur MCP distant, protégé par OAuth** : le même serveur en
  Streamable HTTP sur 127.0.0.1, qui n'accepte que des jetons JWT signés par
  un serveur d'autorisation (`apps/auth-server`) et émis **pour lui**
  (`aud`) ; l'API les découvre, les demande et les renouvelle (par défaut,
  `MCP_TRANSPORT=http`) ;
- **ressources et prompts MCP** : le menu `/` lance un prompt du serveur
  (résumer, comparer, question sourcée) avec autocomplétion, le bouton 📎
  joint un document ; les droits de l'utilisateur s'appliquent partout.

## Installation

Prérequis : Node >= 20.19 (fichier `.nvmrc` fourni), et Docker pour la base
de documents.

```bash
npm install
cp apps/api/.env.example apps/api/.env
# puis renseigner LLM_API_KEY et EMBEDDING_API_KEY dans apps/api/.env
npm run db:up && npm run db:migrate     # base Postgres + pgvector
npm run rag:sample-pdf && npm run ingest # un document de test, ingéré
```

## Lancement

```bash
npm run dev          # api (http://localhost:3000) + web (http://localhost:5173) en parallèle
npm run typecheck    # vérification des types dans chaque workspace (compile packages/rag au passage)
npm run hello        # envoie une question en dur au LLM et affiche la réponse en flux
npm run mcp:probe -- --user chloe ["question"] [--k 3]   # client MCP de l'API, sans modèle : outils vus, une recherche
```

Le front relaie tout appel à `/api/*` vers le backend (proxy Vite).

## Historique des conversations

Les conversations vivent **uniquement dans le navigateur** (`apps/web/src/storage/`) :
une base IndexedDB `chatbot`, avec un magasin `conversations` et un magasin `keys`.
Chaque conversation (utilisateur, titre, dates, messages, sources affichées)
est chiffrée d'un bloc en AES-GCM 256, avec un IV aléatoire de 12 octets à chaque
écriture ; seul son identifiant aléatoire reste en clair. La clé est un `CryptoKey`
non extractible, rangé tel quel dans IndexedDB. Les échanges d'outils ne sont
pas conservés. Le serveur reçoit toujours les messages de la conversation
courante, le temps de la requête, et ne garde rien.

Une fiche qui ne se déchiffre plus (données corrompues, clé perdue) apparaît
« illisible » sans gêner les autres. « Tout effacer » supprime conversations
et clé : rien n'est récupérable. Deux onglets sur la même conversation : la
dernière écriture gagne. Ce que ce chiffrement protège, et surtout ce qu'il
ne protège pas (XSS, extension, session ouverte, profil copié en entier) :
[`docs/securite/memoire-locale.md`](docs/securite/memoire-locale.md).

## API

| Route | Rôle |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }` |
| `GET /api/users` | `{ users: [{ id, nom }] }` : les utilisateurs fictifs, pour le sélecteur de l'interface (jamais leurs groupes) |
| `POST /api/chat` | En-tête `X-User-Id` obligatoire (sinon 401). Corps `{ messages: [{ role, content }], debug?: boolean }`. Réponse en flux SSE. |

`X-User-Id` est un **remplaçant d'authentification** pour l'exercice
(`apps/api/src/auth/fake-identity.ts`) : n'importe quel client peut se
déclarer n'importe qui. En production, l'identité viendrait d'une session ou
d'un jeton vérifié par le serveur.

Événements du flux `/api/chat` :

| Événement | Données |
| --- | --- |
| `sources` | `{ sources: [{ index, fileName, pageStart, pageEnd, score, excerpt }] }` : les passages retrouvés ; `index` est le numéro cité `[n]`. Mode `always` : une fois, avant le premier `delta`. Mode `tool` : après chaque recherche du modèle, avec toutes les sources de la requête (le client remplace sa liste) |
| `delta` | `{ text }` : un fragment de la réponse |
| `tool_call` | `{ name, input }` : le modèle demande un outil |
| `tool_result` | `{ name, ok }` : l'outil a été exécuté |
| `debug` | seulement si `debug: true` : à chaque tour, la requête envoyée au modèle (prompt système, historique, outils) puis sa réponse |
| `done` | fin normale |
| `error` | `{ message }` : erreur, recherche documentaire indisponible, ou plafond de 5 tours d'outils atteint. Mode `tool` : envoyé à la place de `done`, après la réponse du modèle, si une recherche a échoué |

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Combien font 1234 * 5678 ?"}]}'
```

## RAG : ingestion, recherche et réponse

Le code commun vit dans `packages/rag/` (`@chatbot/rag`), importé par l'API
et par le serveur MCP. Les scripts d'ingestion restent dans
`apps/api/src/rag/scripts/`, séparés du serveur ; les prompts
(`buildRagPrompt`, `buildToolSystemPrompt`) restent dans
`apps/api/src/rag/prompt.ts`.

```bash
npm run db:up                             # Postgres 17 + pgvector (docker compose, port 5433)
npm run db:migrate                        # crée les tables documents et chunks, puis l'index plein texte
# déposer des PDF dans apps/api/data/pdfs/ (ignoré par git)
npm run rag:preview -- mon.pdf [--short]  # affiche les chunks d'un PDF, sans rien écrire
npm run rag:embed-check                   # vérifie la configuration Voyage sur 3 phrases
cp apps/api/data/pdfs/acl.example.json apps/api/data/pdfs/acl.json   # droits : fichier → groupes autorisés
npm run ingest                            # ingère data/pdfs/ (idempotent, par sha256) et réapplique l'ACL
npm run search -- --user bruno "ma question" [--mode vector|lexical|hybrid] [--sql] [--explain]   # 5 chunks autorisés les mieux classés
npm run ask -- --user alice "ma question" [--k 5]   # prompt RAG assemblé, réponse, sources citées
npm run rag:sample-pdf                    # génère data/pdfs/reglement-interieur.pdf (document de test fictif)
```

### Jeu de test

20 questions typées dans `apps/api/evals/questions.json` (versionné). Les runs
vont dans `apps/api/evals/runs/` (ignoré par git : ils contiennent des
extraits des documents).

```bash
npm run eval:run -- --user chloe [--mode hybrid] [--only q01,q13]   # rejoue les questions → <date>.json, <date>.md, <date>.notes.json
npm run eval:score -- <date>              # additionne les notes saisies à la main, détail par type, échecs
npm run eval:compare -- <A> <B> [<C>]     # rang du bon passage dans chaque run, calculé depuis les pages attendues
npm run eval -- --user chloe [--mode hybrid] [--rag-mode always|tool]   # run + graders (code et juge) → <date>.scores.json, rapport <date>.md, evals/history.jsonl
npm run eval:grade -- <date>              # graders par code seuls, sur un run existant (sans modèle)
npm run eval:calibrate -- <date> [--repeat 2]  # accord du juge avec les notes manuelles, stabilité
npm run eval:history                      # évolution des scores, un run par ligne
```

En mode `tool`, chaque résultat note combien de fois le modèle a appelé
`search_documents` et avec quelles questions (`recherches`,
`questions_recherche`) ; le mode apparaît dans les rapports, l'historique
(colonne `rag`) et `eval:compare`. Les deux modes se lancent l'un après
l'autre, jamais en parallèle (quota Voyage).

Le pipeline : extraction page par page (pdf.js), nettoyage (en-têtes et pieds
répétés, césures, ligatures), découpage en chunks d'environ 500 tokens avec
15 % de recouvrement et les numéros de page, embeddings par lots avec
nouvelles tentatives sur 429/5xx, puis écriture dans une transaction.

La recherche a trois modes (`RAG_SEARCH_MODE`, ou `--mode` dans les
scripts) : `vector` (pgvector, distance cosinus), `lexical` (plein texte
Postgres, configuration `french`, index GIN) et `hybrid` (les deux en
parallèle, fusionnées par Reciprocal Rank Fusion).

**Droits d'accès.** Chaque document a une liste de groupes autorisés
(`data/pdfs/acl.json`, ignoré par Git ; un PDF absent n'est visible par
personne), chaque utilisateur une liste de groupes (`data/users.json`). La
recherche ne renvoie que les chunks des documents qui partagent au moins un
groupe avec l'utilisateur, filtrés dans le `WHERE` de chaque requête SQL.
Avec l'ACL d'exemple : alice (`rh`) voit le règlement, bruno (`tech`)
DiscordInvites, chloe les deux.

## Serveur MCP

Le RAG est aussi exposé comme serveur MCP, en transport stdio
(`apps/mcp-server`). Il se connecte directement à la base et lit
`apps/api/.env` et `apps/api/data/users.json`. L'utilisateur est fixé au
lancement par `MCP_USER_ID` : sans lui, ou s'il est inconnu, le serveur
refuse de démarrer.

| Outil | Arguments | Rôle |
| --- | --- | --- |
| `search_documents` | `question`, `k` (1 à 10, 5 par défaut) | les passages les plus proches, parmi les documents autorisés : fichier, pages, extrait, score |
| `list_documents` | aucun | les documents autorisés : fichier, nombre de pages, date d'ingestion |

```bash
npm run --silent mcp                     # compile puis lance le serveur (attend un client sur stdin)
npm run --silent mcp -- --transport http # serveur HTTP sur http://127.0.0.1:3100/mcp (MCP_HTTP_PORT)
npx @modelcontextprotocol/inspector -e MCP_USER_ID=chloe npm run --silent mcp   # MCP Inspector (interface web)
npx @modelcontextprotocol/inspector --cli --config .mcp.json --server chatbot-rag --method tools/list
```

`.mcp.json`, à la racine, déclare ce serveur pour Claude Code (avec
`MCP_USER_ID=chloe`) : lance `claude` dans ce dossier, accepte le serveur,
puis `/mcp` pour voir son état. En stdio, rien ne doit être écrit sur
stdout en dehors du protocole : d'où `--silent`, et les logs sur stderr.

### L'API, client MCP

En `RAG_MODE=tool` (par défaut), `/chat` ne cherche plus avant le modèle :
il lui donne les outils maison et ceux du serveur MCP de l'utilisateur,
préfixés `mcp__rag__` (`apps/api/src/mcp/`). L'API lance **un serveur MCP
par utilisateur** (sous-processus stdio, `MCP_USER_ID` fixé au lancement) :
un serveur partagé donnerait à chacun les droits du premier. Le serveur est
démarré au premier message, réutilisé, puis fermé après 5 minutes
d'inactivité.

Si le serveur MCP tombe ou ne démarre pas, les outils maison restent
utilisables ; une recherche répond « indisponible » au modèle, l'interface
reçoit un `error`, et le serveur n'est pas relancé pendant 30 s. À l'arrêt
de l'API (Ctrl+C, SIGTERM), tous les serveurs MCP sont fermés. Les logs
donnent l'outil, l'utilisateur et la durée, jamais la question ni les
extraits.

### Le serveur en HTTP, protégé par OAuth

Trois processus, que `npm run dev` lance avec le front :

```bash
npm run auth                              # serveur d'autorisation, http://127.0.0.1:3200
npm run mcp -- --transport http           # serveur MCP, http://127.0.0.1:3100/mcp
npm run dev -w apps/api                   # l'API, client OAuth
```

- Le **serveur d'autorisation** délivre des JWT ES256 de 5 minutes (`POST /token`)
  et publie sa clé publique (`/.well-known/jwks.json`). Une clé neuve à chaque démarrage.
- Le **serveur MCP** vérifie signature, `iss`, **`aud`** (sa propre URL), `exp`, `typ` et le
  scope `documents:read`. Il publie `/.well-known/oauth-protected-resource/mcp` (RFC 9728),
  et ses 401 et 403 indiquent où obtenir un jeton. La session MCP est liée à l'utilisateur (`sub`).
- L'**API** ne connaît que `MCP_HTTP_URL` et ses identifiants de client (`OAUTH_CLIENT_ID`,
  `OAUTH_CLIENT_SECRET`) : elle découvre le reste à partir d'un 401.

Simplification d'exercice : l'API nomme l'utilisateur dans sa demande de jeton
(`client_credentials` + `subject`) au lieu du flux *authorization code* + PKCE.

```bash
npm run mcp:auth-probe                    # 15 contrôles : aud, signature, alg none, expiration, scope, session
npm run mcp:probe -- --user chloe         # le client de l'API, outils compris
MCP_TRANSPORT=stdio npm run mcp:probe -- --user chloe   # l'ancien mode, un sous-processus par utilisateur
```

### Ressources et prompts

Le serveur MCP expose aussi `rag://documents` (catalogue) et
`rag://documents/{fichier}` (texte d'un document), ainsi que les prompts
`resumer_document`, `comparer_documents` et `question_sourcee`, filtrés par
les droits de l'utilisateur. L'API les liste (`GET /api/mcp/resources`,
`GET /api/mcp/prompts`, `POST /api/mcp/complete`) et accepte dans `/chat`
des références (`attachments`, `prompt`) qu'elle résout elle-même à chaque
requête.

Pour arrêter la base : `docker compose down` (les données restent dans le
volume), ou `docker compose down -v` pour tout effacer.

## Variables d'environnement

Elles vivent uniquement dans `apps/api/.env` (ignoré par git), lu aussi par
le serveur MCP. Chaque
programme refuse de démarrer si une variable dont il a besoin manque : le
serveur les exige toutes, les scripts RAG seulement les leurs (`db:migrate`
fonctionne sans clé). Une base arrêtée n'empêche pas le serveur de démarrer :
le chat renvoie alors une erreur « recherche indisponible ».

| Variable | Rôle | Exemple |
| --- | --- | --- |
| `LLM_PROVIDER` | Fournisseur LLM. Valeurs possibles : `anthropic` | `anthropic` |
| `LLM_API_KEY` | Clé API du fournisseur, côté serveur seulement | `sk-ant-...` |
| `LLM_MODEL` | Identifiant du modèle | `claude-opus-5-5` |
| `PORT` | Port de l'API (optionnel) | `3000` |
| `DATABASE_URL` | Base Postgres + pgvector du RAG | `postgres://rag:rag@localhost:5433/rag` |
| `EMBEDDING_PROVIDER` | Fournisseur d'embeddings. Valeurs possibles : `voyage` | `voyage` |
| `EMBEDDING_API_KEY` | Clé API Voyage AI | `pa-...` |
| `EMBEDDING_MODEL` | Modèle d'embeddings | `voyage-3.5` |
| `EMBEDDING_DIMENSION` | Dimension des vecteurs (256, 512, 1024 ou 2048). Figée dans la colonne SQL à la migration. | `1024` |
| `RAG_SEARCH_MODE` | Recherche par défaut : `vector`, `lexical` ou `hybrid`. Optionnelle (`vector` si absente). | `vector` |
| `RAG_MODE` | `tool` : le modèle décide d'appeler `search_documents` (serveur MCP) ; `always` : recherche avant chaque message. Optionnelle (`tool` si absente). | `tool` |
| `MCP_TRANSPORT` | Comment l'API joint le serveur MCP : `http` (serveur distant, OAuth) ou `stdio` (un sous-processus par utilisateur). Optionnelle (`http` si absente). | `http` |
| `MCP_HTTP_URL` | Adresse du serveur MCP en HTTP, pour l'API. Optionnelle. | `http://127.0.0.1:3100/mcp` |
| `MCP_HTTP_PORT` | Port du serveur MCP lancé avec `--transport http` (écoute sur 127.0.0.1). Optionnelle. | `3100` |
| `MCP_PUBLIC_URL` | Identifiant de la ressource MCP, c'est-à-dire l'audience exigée dans les jetons. Optionnelle. | `http://127.0.0.1:3100/mcp` |
| `AUTH_ISSUER` | URL du serveur d'autorisation (émetteur `iss`, et son port d'écoute). Optionnelle. | `http://127.0.0.1:3200` |
| `AUTH_TOKEN_TTL_S` | Durée de vie des jetons, en secondes. Optionnelle. | `300` |
| `AUTH_JWKS_URL` | Où le serveur MCP lit les clés publiques. Optionnelle (`<AUTH_ISSUER>/.well-known/jwks.json`). | |
| `OAUTH_CLIENT_ID` | Identifiant du client OAuth de l'API. Optionnelle. | `chatbot-api` |
| `OAUTH_CLIENT_SECRET` | Secret du client OAuth, 32 caractères au moins (`openssl rand -hex 32`). Obligatoire en `MCP_TRANSPORT=http`. | |
| `MCP_USER_ID` | Utilisateur du serveur MCP (`data/users.json`). Passée par le client MCP (`.mcp.json`, Inspector), pas dans `.env`. Ignorée en HTTP. | `chloe` |
| `EVAL_JUDGE_MODEL` | Modèle juge de l'exactitude (`npm run eval`), distinct de `LLM_MODEL` et acceptant `temperature: 0`. Optionnelle. | `claude-haiku-4-5` |

Les clés ne sont jamais exposées au front : Vite ne publie que les variables
préfixées `VITE_`, et `apps/web` n'a pas de fichier `.env`.

Changer `EMBEDDING_MODEL` ou `EMBEDDING_DIMENSION` impose de tout réingérer
(et, pour la dimension, de recréer le schéma) : les vecteurs de deux modèles
ne sont pas comparables.

## Architecture

```
packages/rag/                @chatbot/rag, partagé par l'API et le serveur MCP
├─ src/retrieve.ts           createRetriever → retrieve(question, { userGroups, k, mode })
├─ src/acl.ts, users.ts      droits par document, utilisateurs fictifs (chemins donnés par l'application)
├─ src/oauth.ts              constantes OAuth partagées : émetteur, ressources, scopes
├─ src/config.ts, env.ts     configuration lue dans process.env, ConfigError, loadDotEnv(fichier)
├─ src/pdf/, text/           extraction, nettoyage, découpage (fonctions pures)
├─ src/embeddings/           EmbeddingClient + fabrique ; seul voyage.ts connaît l'API Voyage
├─ src/db/                   pool, migrations, requêtes SQL (recherche, ACL, liste des documents)
└─ migrations/               fichiers SQL
apps/api/src/
├─ server.ts, config.ts      démarrage Fastify, configuration, chemins (.env, data/)
├─ routes/chat.ts            POST /api/chat : identité, références MCP, mode always ou tool, sources, flux SSE
├─ routes/mcp.ts             GET /api/mcp/resources, GET /api/mcp/prompts, POST /api/mcp/complete
├─ chat/mcp-context.ts       pièces jointes et prompts → contenu, au nom de l'utilisateur
├─ chat/conversation.ts      boucle modèle ↔ outils (partagée par /chat et l'évaluation)
├─ chat/search-results.ts    résultats de search_documents → extraits numérotés, sources
├─ mcp/                      client MCP : une connexion par utilisateur (stdio ou http + OAuth), outils MCP → registre, mcp:probe, mcp:auth-probe
├─ auth/fake-identity.ts     X-User-Id, remplaçant d'authentification
├─ llm/                      LlmClient + fabrique ; seul anthropic.ts importe le SDK
├─ tools/                    registre d'outils (Zod ou JSON Schema, délai par outil, erreurs → résultat)
├─ rag/prompt.ts             prompts système (always, tool), buildRagPrompt, extractCitations (purs)
├─ rag/scripts/              migrate, preview, embed-check, ingest, search, ask, sample-pdf
└─ evals/                    run, graders (code + juge), scores, rapport, historique, calibration, comparaison
apps/mcp-server/src/
├─ index.ts                  config → base → --transport stdio|http
├─ server.ts                 createRagServer(context) : McpServer + outils, ressources, prompts
├─ transports/               stdio ; http (/mcp, /health, métadonnées RFC 9728, Host/Origin, JWT, sessions) ; journal des appels d'outils
├─ auth.ts                   JWT → utilisateur : signature (JWKS), iss, aud, exp, typ, scope
├─ config.ts, log.ts         MCP_USER_ID ou configuration OAuth, .env de l'API ; logs sur stderr uniquement
├─ tools/                    search_documents, list_documents, runTool (erreur → isError)
├─ resources/                rag://documents, rag://documents/{fichier} (droits, autocomplétion)
└─ prompts/                  resumer_document, comparer_documents, question_sourcee
apps/auth-server/src/        clés ES256, JWKS, métadonnées RFC 8414, POST /token (aud = resource)
apps/web/src/chat/           UI du chat, hook useChat, parseur SSE, citations et sources, journal d'événements
apps/web/src/mcp/            menu « / » des prompts, autocomplétion, pièces jointes
apps/web/src/storage/        historique local : IndexedDB, AES-GCM (Web Crypto), clé, sauvegarde différée, panneau des conversations
```

Une règle commune : le reste du code ne dépend d'aucun fournisseur. On
n'importe que `llm/index.js` (`LlmClient`, `createLlmClient`) ou
`@chatbot/rag/embeddings/index` (`EmbeddingClient`, `createEmbeddingClient`).

## Travailler avec Claude Code

Les bonnes pratiques pour démarrer un projet (CLAUDE.md, une session par
fonctionnalité, modèle de brief, autorisations, hooks, vérifications) :
[`docs/bonnes-pratiques-claude-code.md`](docs/bonnes-pratiques-claude-code.md).

## Cours

Chaque fonctionnalité est accompagnée d'un cours dans `docs/cours/`, avec un
[sommaire](docs/cours/README.md) qui décrit aussi la trame commune : leçons
appuyées sur le code, questions et corrigé.

| Fichier | Sujet |
| --- | --- |
| `docs/cours/jour-1-flux-dun-message.md` | Jour 1 · Le voyage d'un message : React → Fastify → LLM, streaming SSE |
| `docs/cours/jour-1-appel-doutils.md` | Jour 1 · Le tool use : format neutre, boucle, registre d'outils |
| `docs/cours/jour-2-ingestion.md` | Jour 2 · L'ingestion d'un RAG : pgvector, découpage, embeddings, recherche |
| `docs/cours/jour-2-recherche-reponse.md` | Jour 2 · La réponse sourcée : `retrieve`, prompt RAG, `/chat`, citations dans l'interface |
| `docs/cours/jour-2-jeu-de-test.md` | Jour 2 · Le jeu de test : questions, runs, notation, lecture des échecs |
| `docs/cours/jour-3-hybride.md` | Jour 3 · La recherche hybride : plein texte Postgres, identifiants, fusion RRF, comparaison des modes |
| `docs/cours/jour-3-droits.md` | Jour 3 · Les droits d'accès : ACL par document, filtre dans la recherche, identité dans l'API |
| `docs/cours/jour-4-evaluation.md` | Jour 4 · L'évaluation automatique : graders par code, juge LLM calibré, commande unique, historique |
| `docs/cours/jour-4-serveur-mcp.md` | Jour 4 · Le serveur MCP : package partagé, stdio, identité fixée au lancement, outils, Inspector, `.mcp.json` |
| `docs/cours/jour-4-client-mcp.md` | Jour 4 · L'API, client MCP : un serveur par utilisateur, le modèle décide de chercher, panne du serveur, comparaison des deux modes |
| `docs/cours/jour-4-serveur-distant.md` | Jour 4 · Le serveur MCP distant : Streamable HTTP, sessions, jeton par requête, OAuth 2.1 expliqué, client HTTP dans l'API |
| `docs/cours/jour-4-memoire-chiffree.md` | Jour 4 · La mémoire chiffrée : IndexedDB, AES-GCM, clé non extractible, sauvegarde différée, menaces |
| `docs/cours/jour-6-oauth-mcp.md` | Jour 6 · Le serveur MCP distant, protégé par OAuth : serveur d'autorisation, JWT, découverte, audience, scopes, rotation |
| `docs/cours/jour-6-ressources-prompts.md` | Jour 6 · Ressources et prompts MCP : les trois primitives, autocomplétion, références résolues par l'API, menu « / » |
