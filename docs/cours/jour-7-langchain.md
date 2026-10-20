# Jour 7 · Cours 1 — LangChain : ce qu'un framework simplifie, et ce qu'il ne fait pas

> [Sommaire](README.md) · Précédent : [Jour 6 · Cours 2 — Ressources et prompts MCP](jour-6-ressources-prompts.md) · [Approfondissement : le code](approfondissement/jour-7-langchain.md)

> **Prérequis.** [Le tool use](jour-1-appel-doutils.md) (notre client LLM,
> notre registre, notre boucle) et [l'API, client MCP](jour-4-client-mcp.md).
> Tout ce que ce cours remplace a été écrit à la main avant.
>
> **Le fil rouge.** chloe demande « Qui est la référente télétravail ? ». La
> question suit le même chemin qu'avant (recherche MCP, sources, réponse
> citée), mais la boucle est maintenant celle de LangChain. On vérifie
> ensuite qu'un document piégé ne déclenche toujours aucune action.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous remplacé, et que gagne-t-on ? |
| 1 | Que fait `createAgent` à notre place ? |
| 2 | Où va ce qui est propre à l'application ? |
| 3 | Un framework est-il sûr par défaut ? |
| 4 | Pourquoi l'adaptateur MCP de LangChain n'est-il pas utilisé ? |
| 5 | Qu'est-ce qui reste écrit à la main, et pourquoi ? |
| 6 | Quand ça se passe mal |
| 7 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Sur la branche `langchain`, la couche LLM, le registre d'outils et la boucle
sont remplacés par LangChain 1.x. Le RAG, les deux serveurs (MCP et
autorisation) et le front ne changent pas.

| Avant (fait main) | Après (LangChain) |
| --- | --- |
| `llm/anthropic.ts`, `factory.ts`, `types.ts` : format neutre, streaming, reconstitution des `tool_use` | `ChatAnthropic` de `@langchain/anthropic`, dans `llm/index.ts` |
| `tools/registry.ts`, `types.ts` : validation zod, JSON Schema, délai, erreurs | `tool()` de `@langchain/core`, plus un middleware `tools/guard.ts` |
| `chat/conversation.ts` : la boucle de 5 tours | `createAgent` + `modelCallLimitMiddleware`, dans `chat/agent.ts` |
| `mcp/tools.ts` : outils MCP pour notre registre | le même fichier, qui produit des outils LangChain |

**Mesuré** : ces modules passent de **906 à 680 lignes** (−226, soit −25 %).
C'est moins que les 500 à 700 lignes estimées avant de commencer : le garde
et la traduction vers le SSE restent à écrire.

---

## Leçon 1 : `createAgent` fait la boucle

```ts
const agent = createAgent({
  model, tools, systemPrompt: system,
  middleware: [observe(options), toolGuard({ confirm }), modelCallLimitMiddleware({ runLimit: MAX_TOOL_TURNS, exitBehavior: "error" })],
});
const stream = await agent.stream({ messages: toLangChainMessages(messages) }, { streamMode: "messages", signal });
```

- Ce qu'on n'écrit plus : appeler le modèle, lire ses `tool_calls`, exécuter
  les outils (en parallèle), renvoyer les `ToolMessage`, recommencer. C'était
  le cœur du cours du jour 1.
- Ce qu'on n'écrit plus non plus : la reconstitution d'un appel d'outil à
  partir des fragments `input_json_delta`. `ChatAnthropic` s'en charge.
- Le plafond de 5 tours est un middleware **fourni** :
  `modelCallLimitMiddleware`. Observé avec un faux modèle qui demande un outil
  à chaque tour : 5 appels, puis `completed: false`.
- `streamMode: "messages"` donne les fragments du modèle au fil de l'eau.
  Observé : 14 événements `delta` pour la réponse du fil rouge.

> **À retenir**
> Un framework d'agent remplace la boucle, pas les règles de l'application.

---

## Leçon 2 : les middlewares

```ts
wrapToolCall: async (request, handler) => {
  emit({ event: "tool_call", data: { name, input } });
  const result = await handler(request);
  // … ok, log, emit tool_result, onToolResult
  return result;
},
```

- Un middleware **entoure** un appel au modèle (`wrapModelCall`) ou à un
  outil (`wrapToolCall`), comme un middleware HTTP entoure une requête.
- Trois middlewares, dans cet ordre (le premier enveloppe les suivants) :
  1. **`observe`** : les événements SSE `tool_call`, `tool_result` et `debug`, et les logs ;
  2. **`toolGuard`** : verrou sur les effets de bord, délai, erreurs lisibles ;
  3. **`modelCallLimitMiddleware`** : le plafond de tours.
- L'interface ne voit aucune différence : les mêmes événements SSE, dans le
  même ordre. Testé : mode `tool`, mode `always` avec debug, serveur MCP injoignable, client déconnecté.
- Ce qui disparaît : la classe `ToolRegistry`. Ce qui reste : ses **règles**,
  déplacées dans un middleware.

> **À retenir**
> Ce qui est propre à l'application (sécurité, observabilité) se branche autour de l'agent, sans le réécrire.

**Question**
1. Pourquoi `observe` est-il placé **avant** `toolGuard` dans la liste ?

---

## Leçon 3 : sûr par défaut ?

Premier essai, avec des arguments invalides : voici ce que le modèle aurait lu.

```
Error invoking tool 'calculate' with kwargs {"expression":""} with error: Error: Received tool input did not match expected schema
✖ L'expression est vide.
  → at expression
    at DynamicStructuredTool.call (/Users/…/node_modules/@langchain/core/src/tools/index.ts:252:15)
    at async wrapToolCall (/Users/…/apps/api/src/tools/guard.ts:65:16)
```

- Le message d'erreur de LangChain contient la **pile d'appels**, avec les
  chemins du serveur. Il aurait été envoyé au modèle, puis peut-être recopié
  dans une réponse : c'est une fuite d'information (jour 5, LLM02 et LLM07).
- Sans middleware, LangChain ajoute aussi `Please fix your mistakes.` à toute
  erreur d'outil. Notre `UNAVAILABLE_MESSAGE` aurait été noyé dedans.
- Le garde déballe `ToolInvocationError` et ne transmet que la cause :
  `Arguments invalides. expression : L'expression est vide.`, comme avant.
- Un nom d'outil inventé par le modèle était d'abord présenté comme une
  « Action refusée ». Corrigé : `Outil inconnu : "inconnu".`
- Le verrou du jour 5 tient. La sonde déterministe `verrou.mts`, portée vers
  LangChain, répond `BLOQUÉ`.

> **À retenir**
> Les choix par défaut d'un framework sont faits pour démarrer vite, pas pour votre modèle de menace : on les vérifie, avec les mêmes sondes qu'avant.

**Question**
1. Pourquoi est-ce une sonde **déterministe** (un faux modèle) qui prouve le verrou, et pas une vraie question ?

---

## Leçon 4 : l'adaptateur MCP, non utilisé

- `@langchain/mcp-adapters` 2.0 transforme un client MCP en outils LangChain.
  C'était le plan.
- À l'essai, l'adaptateur appelle `client.getProtocolEra()`, une méthode du
  **SDK MCP v2** (`@modelcontextprotocol/client`). Notre pool et notre serveur
  sont en SDK **1.32**.
- L'utiliser, c'était remplacer le pool entier : sessions par utilisateur,
  disjoncteur, jetons OAuth du jour 6. Tout cela pour gagner une trentaine de lignes.
- À la place, `mcp/tools.ts` appelle `tool()` avec le **JSON Schema** annoncé
  par le serveur MCP, que LangChain accepte tel quel.

> **À retenir**
> Un framework impose les versions de ses dépendances. Avant d'adopter une brique, on vérifie qu'elle parle à ce qu'on a déjà.

---

## Leçon 5 : ce qui reste fait main

| Brique | Pourquoi elle reste |
| --- | --- |
| Découpage par pages, en tokens (`packages/rag/src/text/`) | les citations « p. 3–4 » en dépendent ; `RecursiveCharacterTextSplitter` ne suit pas les pages |
| Recherche et droits (`retrieve.ts`, SQL) | le filtre `allowed_groups && $groups` placé **avant** le `LIMIT` n'a pas d'équivalent simple dans `PGVectorStore` : un risque de fuite |
| Hybride RRF | 20 lignes, testées ; `EnsembleRetriever` n'apporterait rien |
| Pool MCP, OAuth, ressources et prompts | voir la leçon 4 |
| Numérotation des sources, événements SSE | propres à notre interface |
| Évaluations | LangSmith est un service externe ; l'historique `evals/` existe déjà |

> **À retenir**
> LangChain simplifie l'**orchestration** (modèle, outils, boucle). Les **données** (découpage, droits, recherche) restent l'affaire de l'application.

---

## Leçon 6 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| le modèle demande des outils à chaque tour | 5 appels au modèle, puis `error` « trop d'appels d'outils » |
| arguments invalides | `Arguments invalides. expression : L'expression est vide.` (sans pile) |
| outil inconnu | `Outil inconnu : "…".` |
| outil sans `metadata.readOnly` | refusé : `Action refusée : … exige la confirmation explicite…` |
| outil trop lent | `L'outil "…" a dépassé le délai de … ms.` |
| serveur MCP injoignable | l'outil répond `UNAVAILABLE_MESSAGE`, puis `error` « La recherche dans les documents a échoué » |
| client déconnecté | `client déconnecté, génération annulée` (le `signal` est passé à l'agent) |

---

## Leçon 7 : synthèse

### Les idées à emporter

1. `createAgent` remplace la boucle, `ChatAnthropic` le client, `tool()` le registre.
2. Les règles de l'application vivent dans des **middlewares** autour de l'agent.
3. Les choix par défaut d'un framework se vérifient, avec les mêmes sondes qu'avant.
4. Une brique du framework peut imposer ses versions (adaptateur MCP et SDK v2).
5. Gain réel : −25 % sur l'orchestration, rien sur les données.

### Vérifications manuelles

Sur la branche `langchain`, avec `npm run dev` :

1. **Le chat fonctionne comme avant** : chloe demande « Qui est la référente
   télétravail ? ». Réponse citée, sources, une ligne `outil exécuté` dans les logs.
2. **Le verrou** (sans réseau) :
   ```bash
   cd apps/api && npx tsx --conditions=development ../../security/probes/03-injection/verrou.mts   # BLOQUÉ
   ```
3. **L'évaluation** sur une question :
   ```bash
   npm run eval -- --user chloe --only q01        # recherche 1/1 · citation 1/1 · abstention 1/1 · exactitude 1/1
   ```
4. **Comparer avec la version faite main** :
   `git diff main --stat -- apps/api/src`, puis `git switch main` et pose la même question.

### Pour aller plus loin (non fait, volontairement)

Une évaluation complète sur la branche, à comparer avec la référence du jour
5. La migration du pool vers le SDK MCP v2 pour utiliser l'adaptateur. Le
middleware `humanInTheLoopMiddleware` à la place de `confirm`, avec une
vraie confirmation dans l'interface. LangSmith pour les traces. Et le cache
de prompt, que `ChatAnthropic` sait aussi transmettre.

---

## Corrigé des questions

**L2.1** Pour qu'il voie le résultat **final** de chaque outil, y compris un
refus ou une erreur produits par le garde. Placé après, il ne verrait pas
les appels que le garde bloque.

**L3.1** Un vrai modèle peut résister aujourd'hui et céder demain. Le faux
modèle obéit **toujours** à l'injection : il teste le code, pas le modèle.

---

## Pour aller plus loin dans le code

Pour voir comment le code est écrit, fichier par fichier, lis
[l'approfondissement](approfondissement/jour-7-langchain.md).
