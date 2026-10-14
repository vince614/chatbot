# Chatbot

Mini-projet d'apprentissage : un chatbot React + Node, organisé en monorepo
npm workspaces.

- `apps/api` : backend Node 20+ / Fastify / TypeScript strict
- `apps/web` : frontend React / Vite / TypeScript strict

Fonctionnalités en place :

- **chat en streaming** (SSE) avec un modèle Claude ;
- **tool use** : le modèle peut appeler des outils côté serveur
  (`get_current_datetime`, `calculate`) ;
- **journal d'événements** dans l'interface : actions, requêtes HTTP,
  événements SSE, échanges avec le modèle ;
- **ingestion RAG** : PDF → chunks → embeddings Voyage AI → Postgres +
  pgvector ;
- **réponses sourcées** : à chaque message, le chat cherche les 5 passages
  les plus proches, répond uniquement à partir d'eux (« Je ne sais pas »
  sinon) et cite ses sources `[1]`, `[2]` ; l'interface affiche les sources
  citées, dépliables, et les pastilles renvoient à l'extrait.

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
npm run typecheck    # tsc --noEmit dans chaque workspace
npm run hello        # envoie une question en dur au LLM et affiche la réponse en flux
```

Le front relaie tout appel à `/api/*` vers le backend (proxy Vite).

## API

| Route | Rôle |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }` |
| `POST /api/chat` | Corps `{ messages: [{ role, content }], debug?: boolean }`. Réponse en flux SSE. |

Événements du flux `/api/chat` :

| Événement | Données |
| --- | --- |
| `sources` | `{ sources: [{ index, fileName, pageStart, pageEnd, score, excerpt }] }` : les passages retrouvés, avant le premier `delta` ; `index` est le numéro cité `[n]` |
| `delta` | `{ text }` : un fragment de la réponse |
| `tool_call` | `{ name, input }` : le modèle demande un outil |
| `tool_result` | `{ name, ok }` : l'outil a été exécuté |
| `debug` | seulement si `debug: true` : à chaque tour, la requête envoyée au modèle (prompt système, historique, outils) puis sa réponse |
| `done` | fin normale |
| `error` | `{ message }` : erreur, recherche documentaire indisponible, ou plafond de 5 tours d'outils atteint |

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Combien font 1234 * 5678 ?"}]}'
```

## RAG : ingestion, recherche et réponse

Le code vit dans `apps/api/src/rag/`. L'ingestion est un ensemble de scripts,
séparé du serveur ; la recherche (`retrieve`) et le prompt (`buildRagPrompt`)
sont utilisés à la fois par les scripts et par `POST /api/chat`.

```bash
npm run db:up                             # Postgres 17 + pgvector (docker compose, port 5433)
npm run db:migrate                        # crée les tables documents et chunks, puis l'index plein texte
# déposer des PDF dans apps/api/data/pdfs/ (ignoré par git)
npm run rag:preview -- mon.pdf [--short]  # affiche les chunks d'un PDF, sans rien écrire
npm run rag:embed-check                   # vérifie la configuration Voyage sur 3 phrases
npm run ingest                            # ingère data/pdfs/ (idempotent, par sha256)
npm run search -- "ma question" [--mode vector|lexical|hybrid] [--sql] [--explain]   # 5 chunks les mieux classés
npm run ask -- "ma question" [--k 5]      # prompt RAG assemblé, réponse, sources citées
npm run rag:sample-pdf                    # génère data/pdfs/reglement-interieur.pdf (document de test fictif)
```

### Jeu de test

20 questions typées dans `apps/api/evals/questions.json` (versionné). Les runs
vont dans `apps/api/evals/runs/` (ignoré par git : ils contiennent des
extraits des documents).

```bash
npm run eval:run [-- --mode hybrid] [--only q01,q13]   # rejoue les questions → <date>.json, <date>.md, <date>.notes.json
npm run eval:score -- <date>              # additionne les notes saisies à la main, détail par type, échecs
npm run eval:compare -- <A> <B> [<C>]     # rang du bon passage dans chaque run, calculé depuis les pages attendues
```

Le pipeline : extraction page par page (pdf.js), nettoyage (en-têtes et pieds
répétés, césures, ligatures), découpage en chunks d'environ 500 tokens avec
15 % de recouvrement et les numéros de page, embeddings par lots avec
nouvelles tentatives sur 429/5xx, puis écriture dans une transaction.

La recherche a trois modes (`RAG_SEARCH_MODE`, ou `--mode` dans les
scripts) : `vector` (pgvector, distance cosinus), `lexical` (plein texte
Postgres, configuration `french`, index GIN) et `hybrid` (les deux en
parallèle, fusionnées par Reciprocal Rank Fusion).

Pour arrêter la base : `docker compose down` (les données restent dans le
volume), ou `docker compose down -v` pour tout effacer.

## Variables d'environnement

Elles vivent uniquement dans `apps/api/.env` (ignoré par git). Chaque
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

Les clés ne sont jamais exposées au front : Vite ne publie que les variables
préfixées `VITE_`, et `apps/web` n'a pas de fichier `.env`.

Changer `EMBEDDING_MODEL` ou `EMBEDDING_DIMENSION` impose de tout réingérer
(et, pour la dimension, de recréer le schéma) : les vecteurs de deux modèles
ne sont pas comparables.

## Architecture

```
apps/api/src/
├─ server.ts, config.ts     démarrage Fastify, configuration
├─ routes/chat.ts           POST /api/chat : recherche, sources, boucle modèle ↔ outils, flux SSE
├─ llm/                     LlmClient + fabrique ; seul anthropic.ts importe le SDK
├─ tools/                   registre d'outils (validation Zod, délai, erreurs → résultat)
└─ rag/
   ├─ retrieve.ts           createRetriever → retrieve(question, { k })
   ├─ prompt.ts             prompt système RAG, buildRagPrompt, extractCitations (purs)
   ├─ pdf/, text/           extraction, nettoyage, découpage (fonctions pures)
   ├─ embeddings/           EmbeddingClient + fabrique ; seul voyage.ts connaît l'API Voyage
   ├─ db/                   migrations, requêtes SQL
   └─ scripts/              migrate, preview, embed-check, ingest, search, ask, sample-pdf
apps/api/src/evals/         run, rapport à noter, score (jeu de test)
apps/web/src/chat/          UI du chat, hook useChat, parseur SSE, citations et sources, journal d'événements
```

Une règle commune : le reste du code ne dépend d'aucun fournisseur. On
n'importe que `llm/index.js` (`LlmClient`, `createLlmClient`) ou
`rag/embeddings/index.js` (`EmbeddingClient`, `createEmbeddingClient`).

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
