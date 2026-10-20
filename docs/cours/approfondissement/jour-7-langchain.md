# Jour 7 · Cours 1 — LangChain : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-7-langchain.md)

> Ce document suit le code **tel qu'il est aujourd'hui sur la branche
> `langchain`**. Lis d'abord le cours ; viens ici quand tu veux savoir
> *comment* c'est écrit. Chaque extrait indique son fichier : ouvre-le à côté.

Paquets ajoutés à `apps/api` : `langchain` 1.5, `@langchain/core` 1.2 et
`@langchain/anthropic` 1.5. Le SDK `@anthropic-ai/sdk` reste installé
(`@langchain/anthropic` embarque sa propre version).

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/src/llm/index.ts` | `createChatModel` (ChatAnthropic), `toLangChainMessages`, `streamText`, type `ChatMessage` | 1 |
| `apps/api/src/tools/datetime.ts`, `calculate.ts` | outils maison écrits avec `tool()` ; `metadata.readOnly` | 2 |
| `apps/api/src/tools/guard.ts` | `toolGuard` : verrou, délai, erreurs ; `schemaIssues` | 2, 3 |
| `apps/api/src/chat/agent.ts` | `runAgent` : `createAgent`, middlewares, stream, plafond | 1, 2 |
| `apps/api/src/mcp/tools.ts` | outils MCP → `tool()` avec JSON Schema | 4 |
| `apps/api/src/routes/chat.ts`, `server.ts` | `model` à la place de `llm`, tableaux d'outils à la place du registre | 2 |
| `apps/api/src/evals/run.ts`, `graders/exactitude.ts` | effort épinglé dans le modèle, juge à température 0 | — |
| `apps/api/src/hello.ts`, `rag/scripts/ask.ts`, `mcp/probe.ts` | `streamText`, `tool.invoke` | — |
| `security/probes/03-injection/verrou.mts`, `sonde.mts` | portées vers `runAgent` | 3 |
| Supprimés | `llm/anthropic.ts`, `factory.ts`, `types.ts`, `tools/registry.ts`, `types.ts`, `chat/conversation.ts` | 0 |

## Le parcours dans le code

chloe demande « Qui est la référente télétravail ? » (mode `tool`).

1. `server.ts` : **`createChatModel(config.llm)`** → un `ChatAnthropic`, créé une fois au démarrage.
2. `routes/chat.ts` : identité, schéma, `expandMessages` (inchangés) ; `loadMcpToolsOrFallback` →
   **outils LangChain** ; `tools = [...localTools, ...mcpTools.tools]`.
3. **`runAgent({ model, tools, system, messages, … })`** → `createAgent` avec trois middlewares →
   `agent.stream(..., { streamMode: "messages", signal })`.
4. L'agent appelle le modèle. **`observe.wrapModelCall`** compte le tour (et émet `debug` si demandé),
   puis le modèle demande `mcp__rag__search_documents`.
5. L'agent exécute l'outil à travers **`observe.wrapToolCall`** (`tool_call` émis), puis **`toolGuard`**
   (lecture seule : on passe ; délai de 16 s), puis la fonction de l'outil (`mcp/tools.ts`) →
   `pool.callTool` → résultat reformaté par `createSearchResults().format`.
6. Retour dans `observe` : `ok`, log `outil exécuté`, `tool_result`, `onToolResult` → la route envoie `sources`.
7. Second appel au modèle : il répond. Chaque fragment arrive dans la boucle `for await` de
   `runAgent` → événement `delta`. Fin du flux → `{ completed: true, text }` → `done`.

---

## `apps/api/src/llm/index.ts`

```ts
export function createChatModel({ provider, apiKey, model }: LlmClientOptions, settings: ModelSettings = {}): BaseChatModel {
  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({
        apiKey, model, maxTokens: MAX_OUTPUT_TOKENS,
        ...(settings.effort && { outputConfig: { effort: settings.effort } }),
        ...(settings.temperature !== undefined && { temperature: settings.temperature }),
      });
```

**Ce que fait le code**
1. Renvoie un `BaseChatModel` : le type commun à tous les modèles de chat LangChain.
2. L'effort (`outputConfig.effort`) et la température sont fixés **à la construction**. L'évaluation crée donc
   son modèle avec `{ effort: "medium" }`, et le juge avec `{ temperature: 0 }`.
3. `toLangChainMessages` traduit nos `{ role, content }` en `SystemMessage`, `HumanMessage` et `AIMessage`.
4. `streamText` sert aux appels sans outils (`hello`, `ask`, mode `always` de l'évaluation, juge) : `model.stream(...)`, puis `chunk.text`.

**Pourquoi**
- Avant, `ChatMessage` pouvait contenir des blocs `tool_call` et `tool_result` : c'était notre format neutre
  pour la boucle. La boucle appartient maintenant à l'agent : l'application ne manipule plus que du texte.
- La température n'est transmise que si elle est fournie. Les modèles 5.x la refusent ; `ChatAnthropic` ne
  l'envoie pas quand elle est absente (vérifié : `hello` et le chat fonctionnent avec `claude-opus-5-5`).

## `apps/api/src/tools/datetime.ts` et `calculate.ts`

```ts
export const calculateTool = tool(async ({ expression }) => JSON.stringify({ expression, result: evaluate(expression) }), {
  name: "calculate",
  description: "…",
  schema,
  metadata: { readOnly: true },
});
```

**Ce que fait le code** : `tool(fonction, { name, description, schema })`. LangChain valide l'entrée avec le
schéma zod, et en tire le JSON Schema envoyé au modèle. La fonction renvoie du texte (`JSON.stringify`).

**Pourquoi**
- `metadata` est un sac libre attaché à l'outil. Le garde y lit `readOnly` et `timeoutMs` : c'est notre
  contrat, pas celui de LangChain.
- L'évaluateur `evaluate` (descente récursive, sans `eval`) n'a pas bougé.

## `apps/api/src/tools/guard.ts` — `toolGuard`

```ts
if (!request.tool) return fail(`Outil inconnu : "${toolCall.name}".`);
if (policy.readOnly !== true && !(confirm && (await confirm({ name: toolCall.name, input: toolCall.args })))) {
  return fail(confirmationRequired(toolCall.name));
}
// …
return await Promise.race([handler(request), timeout]);
// …
const cause = ToolInvocationError.isInstance(error) ? error.toolError : error;
if (cause instanceof ToolInputParsingException) return fail(`Arguments invalides. ${schemaIssues(cause.message)}`);
return fail(cause instanceof Error ? cause.message : String(cause));
```

**Ce que fait le code**
1. `request.tool` absent : le modèle a inventé un nom.
2. Pas de `readOnly: true` et pas de confirmation : un `ToolMessage` en échec, **sans** appeler `handler`.
3. Sinon, `handler(request)` (l'outil) en course contre un minuteur (`metadata.timeoutMs`, 5 s par défaut).
4. Une erreur : on la remonte si le client est parti (`runtime.signal`). Sinon on déballe
   `ToolInvocationError`, et on renvoie la seule cause, ou les problèmes de schéma reformatés par `schemaIssues`.

**Pourquoi**
- Un middleware qui renvoie un `ToolMessage` au lieu de lever : l'agent continue, et le modèle lit l'échec.
  C'est le comportement de notre ancien registre (« jamais d'exception »).
- `schemaIssues` relit le texte de zod (`✖ message`, `→ at chemin`) : moins élégant qu'un accès aux
  `issues`, mais LangChain ne transmet que le message.

## `apps/api/src/chat/agent.ts`

### `runAgent`

```ts
const stream = await agent.stream({ messages: toLangChainMessages(messages) }, { streamMode: "messages", signal });
for await (const [chunk] of stream) {
  if (!AIMessageChunk.isInstance(chunk) || !chunk.text) continue;
  text += chunk.text;
  emit({ event: "delta", data: { text: chunk.text } });
}
// …
} catch (error) {
  if (isModelCallLimit(error)) return { completed: false, text };
  throw error;
}
```

**Ce que fait le code**
1. `createAgent` à **chaque requête** : les outils dépendent de l'utilisateur (outils MCP de sa session).
2. Le flux `messages` livre des paires `[fragment, métadonnées]`. On ne garde que les fragments de texte
   du modèle (`AIMessageChunk`) : les `ToolMessage` passent aussi dans ce flux, mais on les ignore.
3. Le plafond lève une erreur `ModelCallLimitMiddlewareError`. LangChain n'exporte pas cette classe :
   `isModelCallLimit` la reconnaît à son nom ou à son message, en suivant la chaîne `cause`.

**Pourquoi** : `exitBehavior: "end"` aurait arrêté l'agent proprement, mais en ajoutant un message
anglais dans l'historique (`Model call limits exceeded…`), qui risquait de partir dans le flux. Avec
`"error"`, la route garde son propre message.

### `observe`

**Ce que fait le code** : `wrapModelCall` incrémente le tour, émet `debug` avant et après (prompt système,
messages, noms des outils ; puis texte et `tool_calls`), et logue `appels d'outils demandés`.
`wrapToolCall` émet `tool_call`, appelle la suite (le garde), en déduit `ok` (`status !== "error"`) et
`needsConfirmation` (le contenu est le message de refus), puis logue, émet `tool_result` et appelle `onToolResult`.

**Pourquoi** : la route et l'évaluation gardent le même contrat qu'avant (`onToolResult(call, { ok, content })`).
`routes/chat.ts` n'a changé que de quelques lignes.

## `apps/api/src/mcp/tools.ts` — `toLangChainTool`

```ts
return tool(async (input, config) => {
  const signal = AbortSignal.any([config?.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  // …
  result = await pool.callTool(userId, mcpTool.name, input, signal);
  // …
  if (result.isError) throw new Error(textOf(result));
  return options.formatResult?.(mcpTool.name, result) ?? textOf(result);
}, describe(mcpTool, timeoutMs));
```

**Ce que fait le code**
1. `describe` donne le nom préfixé (`mcp__rag__…`), la description et le **JSON Schema** du serveur
   (`schema`), plus `metadata` (`readOnly` d'après `readOnlyHint`, délai + 1 s).
2. L'appel combine le signal de la requête et le délai de l'outil. Le SDK MCP annule alors côté serveur au
   lieu d'attendre.
3. Les échecs **lèvent** (serveur injoignable, délai, `isError`) : le garde en fait un résultat lisible.

**Pourquoi** : la seconde de marge du garde laisse le signal couper en premier. L'annulation MCP part au
serveur, et le message d'erreur est celui de l'outil (« a dépassé le délai »), pas celui du garde.

---

## Pour explorer toi-même

- **Comparer les deux versions** : `git diff main -- apps/api/src/chat/` montre la boucle disparaître.
- **Retirer le garde** de la liste des middlewares, puis lancer `verrou.mts` : `VULNÉRABLE`. Remets-le.
- **Voir le message brut de LangChain** : dans `guard.ts`, renvoie `fail(String(error))` au lieu de la
  cause, puis envoie un calcul vide (« Calcule  ») : la pile d'appels apparaît dans le panneau debug.
- **`exitBehavior: "end"`** dans `agent.ts` : regarde ce qu'il ajoute dans l'historique quand le plafond est atteint.
- **Un autre fournisseur** : `npm install @langchain/openai -w apps/api`, un `case "openai"` dans
  `createChatModel`, et rien d'autre ne change.
