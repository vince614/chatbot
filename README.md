# Chatbot

Mini-projet d'apprentissage : un chatbot React + Node, organisé en monorepo
npm workspaces.

- `apps/api` : backend Node 20+ / Fastify / TypeScript strict
- `apps/web` : frontend React / Vite / TypeScript strict

## Installation

Prérequis : Node >= 20.19 (fichier `.nvmrc` fourni).

```bash
npm install
cp apps/api/.env.example apps/api/.env
# puis renseigner LLM_API_KEY dans apps/api/.env
```

## Lancement

```bash
npm run dev          # api (http://localhost:3000) + web (http://localhost:5173) en parallèle
npm run typecheck    # tsc --noEmit dans chaque workspace
npm run hello        # envoie une question en dur au LLM et affiche la réponse en flux
```

Le front relaie tout appel à `/api/*` vers le backend (proxy Vite).
Route disponible : `GET /api/health`.

## Variables d'environnement

Elles vivent uniquement dans `apps/api/.env` (ignoré par git). Le serveur
refuse de démarrer si l'une d'elles manque.

| Variable       | Rôle                                          | Exemple           |
| -------------- | --------------------------------------------- | ----------------- |
| `LLM_PROVIDER` | Fournisseur LLM. Valeurs possibles : `anthropic` | `anthropic`    |
| `LLM_API_KEY`  | Clé API du fournisseur, côté serveur seulement | `sk-ant-...`     |
| `LLM_MODEL`    | Identifiant du modèle                         | `claude-opus-5-5` |
| `PORT`         | Port de l'API (optionnel)                     | `3000`            |

La clé n'est jamais exposée au front : Vite ne publie que les variables
préfixées `VITE_`, et `apps/web` n'a pas de fichier `.env`.

## Couche LLM

Tout ce qui touche au fournisseur est dans `apps/api/src/llm/`. Le reste du
code n'importe que `./llm/index.js` (types `ChatMessage`, `LlmClient` et
fabrique `createLlmClient`). Seul `llm/anthropic.ts` importe `@anthropic-ai/sdk`.
