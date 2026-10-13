# Approfondissement · Jour 1 · Cours 2 — Le code du tool use

> [← Retour au cours](../jour-1-appel-doutils.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/src/llm/types.ts` | Format neutre : `ContentPart`, `ChatMessage`, `ToolDefinition`, `LlmEvent` | 1 |
| `apps/api/src/llm/anthropic.ts` | Traduction vers le SDK, reconstitution des appels streamés | 1 |
| `apps/api/src/tools/types.ts` | Contrat d'un outil (`Tool`) et d'un résultat | 2 |
| `apps/api/src/tools/datetime.ts` | Outil `get_current_datetime` | 2 |
| `apps/api/src/tools/calculate.ts` | Outil `calculate` et son évaluateur sans `eval` | 2 |
| `apps/api/src/tools/registry.ts` | Validation, délai, annulation, erreurs transformées en résultat | 3 |
| `apps/api/src/tools/index.ts`, `server.ts` | Point d'entrée du dossier, déclaration des outils au démarrage | 3 |
| `apps/api/src/routes/chat.ts` | La boucle `runConversation`, `executeToolCall`, événements SSE | 4 |
| `apps/web/src/chat/types.ts` | `ToolActivity`, `UiMessage` | 5 |
| `apps/web/src/chat/api.ts` | Handlers `onToolCall`, `onToolResult`, `onDebug` | 5 |
| `apps/web/src/chat/useChat.ts` | Mise à jour de la bulle, `markToolResult`, `toWireHistory` | 5 |
| `apps/web/src/chat/ToolActivityLine.tsx` | Une ligne d'affichage par appel d'outil | 5 |

## Le parcours dans le code

De « Combien font 1234 × 5678 ? » à « 7 006 652 » :

1. **Navigateur.** `send` (`useChat.ts`) ajoute le message ; `run` crée une
   bulle vide, `toWireHistory` réduit l'historique à du texte, `streamChat`
   (`api.ts`) fait le `POST /api/chat`.
2. **Route.** `chatRoutes` (`routes/chat.ts`) valide, ouvre le flux SSE,
   fait la recherche documentaire (jour 2), appelle `runConversation`.
3. **Tour 1.** `llm.streamChat` reçoit l'historique et `tools.list()`.
   `anthropic.ts` reconstitue l'appel bloc par bloc et émet
   `{ type: "tool_call", name: "calculate", input: { expression: "1234 * 5678" } }`.
4. **Exécution.** La boucle ajoute le message assistant à `history`, puis
   `executeToolCall` envoie le SSE `tool_call` (ligne « en cours » via
   `onToolCall`), et `tools.execute` (`registry.ts`) valide et lance
   `evaluate` (`calculate.ts`) : `{ ok: true, content: '{"expression":"1234 * 5678","result":7006652}' }`.
5. **SSE `tool_result`.** `markToolResult` passe la ligne en vert.
6. **Tour 2.** Avec le `tool_result` dans `history`, le modèle répond en
   texte : `delta` × n, aucun appel, `runConversation` rend `true`, `done`.

## `apps/api/src/llm/types.ts`

Définit **notre** format de conversation, sans aucun type du SDK.

```ts
/** Un morceau de message. Un message texte simple est un raccourci pour [{ type: "text" }]. */
export type ContentPart =
  | { type: "text"; text: string }
  /** L'assistant demande l'exécution d'un outil. Uniquement dans un message "assistant". */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** Le résultat d'un appel d'outil, renvoyé au modèle. Uniquement dans un message "user". */
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

/** Un message de la conversation, côté utilisateur ou côté assistant. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string | ContentPart[];
};
// …
/** Ce que le modèle émet au fil de l'eau. */
export type LlmEvent =
  /** Un fragment de la réponse textuelle. */
  | { type: "text"; text: string }
  /** Une demande d'exécution d'outil, complète (les arguments sont déjà parsés). */
  | { type: "tool_call"; id: string; name: string; input: unknown };
```

**Ce que fait le code**, dans l'ordre du code :

1. `ContentPart` est une **union discriminée** sur `type`.
2. `tool_call` porte un `id` généré par le fournisseur ; `tool_result` le
   reprend dans `toolCallId`. C'est ce lien qui apparie un résultat à sa
   demande, même si le même outil est appelé deux fois dans un tour.
3. `input` est `unknown` : le type ne promet rien sur ce que le modèle
   envoie. Seul le schéma Zod du registre en fera une donnée typée.
4. `ChatMessage.content` est une chaîne (venue du navigateur) ou un tableau
   de morceaux (construit par la boucle).
5. `ToolDefinition` (coupé : `name`, `description`, `inputSchema`) décrit un
   outil pour le modèle, sans fonction `execute`.
6. `LlmEvent` est ce que rend `LlmClient.streamChat` : des fragments de
   texte, ou un `tool_call` **complet**, arguments déjà parsés.

**Pourquoi c'est écrit ainsi** :

- `ToolDefinition` a la même forme que le `ToolDescriptor` de `tools/` : la
  route passe `tools.list()` à `streamChat` sans conversion, et aucun des
  deux dossiers n'importe l'autre.

*`StreamChatParams.effort` et le type `LlmEffort` ont été ajoutés au jour 2 :
voir [l'approfondissement de la réponse sourcée](jour-2-recherche-reponse.md).*

## `apps/api/src/llm/anthropic.ts`

Le seul fichier qui connaît `tool_use`, `input_schema` et `tool_use_id` :
il traduit dans les deux sens.

### `streamChat` : reconstituer un appel streamé

```ts
    // Un bloc tool_use arrive en plusieurs événements : on reconstitue ses
    // arguments bloc par bloc, indexés par la position du bloc dans la réponse.
    const pendingToolCalls = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            pendingToolCalls.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const pending = pendingToolCalls.get(event.index);
            if (pending) pending.json += event.delta.partial_json;
          }
          break;

        case "content_block_stop": {
          const pending = pendingToolCalls.get(event.index);
          if (pending) {
            pendingToolCalls.delete(event.index);
            yield {
              type: "tool_call",
              id: pending.id,
              name: pending.name,
              // Un outil sans argument n'émet aucun delta : le tampon reste vide.
              input: pending.json === "" ? {} : JSON.parse(pending.json),
            };
          }
          break;
        }
      }
    }
```

**Ce que fait le code**, dans l'ordre du code :

1. Avant cet extrait, `this.client.messages.stream(...)` ouvre le flux
   avec `messages.map(toAnthropicMessage)`, `tools?.map(toAnthropicTool)`
   et le `signal`, qui coupe la requête si le client se déconnecte.
2. `streamChat` est un **générateur asynchrone** (`async *`) : chaque
   `yield` livre un événement à la route sans attendre la fin.
3. `pendingToolCalls` associe l'**index du bloc** (0, 1, 2…) à un appel en
   cours. `content_block_start` d'un `tool_use` y range `id`, `name` et un
   tampon `json` vide.
4. `content_block_delta` : un `text_delta` est relayé tout de suite ; un
   `input_json_delta` ajoute son fragment au tampon (`{"expres`, puis
   `sion": "12`… : pas du JSON valide isolément).
5. `content_block_stop` : l'appel est retiré, son tampon parsé (vide →
   `{}`, car `JSON.parse("")` lèverait) et un `tool_call` émis.
6. Après la boucle (coupé), `stream.finalMessage()` sert à lever une erreur
   si `stop_reason` vaut `refusal`.

**Pourquoi c'est écrit ainsi** :

- Indexer par `event.index` plutôt que garder « le dernier appel » : une
  réponse peut contenir plusieurs blocs `tool_use`, et chaque delta porte
  l'index de son bloc.
- Le texte part tout de suite, l'appel seulement au `stop` : un appel à
  moitié reçu n'est pas exécutable.

*Le paramètre `effort` (`output_config`) passé à `messages.stream` a été
ajouté au jour 2 : voir [l'approfondissement de la réponse sourcée](jour-2-recherche-reponse.md).*

### `toAnthropicBlock` et ses deux voisines

```ts
function toAnthropicBlock(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.content,
        is_error: part.isError,
      };
  }
}
```

**Ce que fait le code** :

`toAnthropicTool` renomme `inputSchema` en `input_schema` ;
`toAnthropicMessage` laisse un `content` chaîne tel quel, sinon traduit
chaque morceau avec `toAnthropicBlock`, qui fait la correspondance terme à
terme (`tool_call` → `tool_use`, `toolCallId` → `tool_use_id`, `isError` →
`is_error`).

**Pourquoi c'est écrit ainsi** : pas de `default` et un type de retour
imposé. Un quatrième cas ajouté à `ContentPart` sans traitement ici
laisserait un chemin sans `return`, et TypeScript refuserait de compiler.

## `apps/api/src/tools/types.ts`

Décrit ce qu'est un outil, sans rien savoir du LLM ni de Fastify.

```ts
export interface Tool<S extends z.ZodType = z.ZodType> {
// …
  schema: S;
  /** Exécute l'outil. Le résultat sera sérialisé en JSON pour le modèle. */
  execute(input: z.infer<S>, context: ToolContext): Promise<unknown>;
}
```

**Ce que fait le code** : `Tool` a aussi un `name` et une `description`
(coupés). Il est **générique** sur `S`, le type du schéma Zod :
`z.infer<S>` calcule le type des arguments, si bien que dans
`calculateTool`, `input` est automatiquement `{ expression: string }`.
`ToolContext` ne contient qu'un `signal` (déconnexion ou délai). Le fichier
définit aussi `ToolDescriptor` (ce que rend `list()`) et
`ToolExecutionResult` (`{ ok, content }`, ce que rend `execute()`).

**Pourquoi c'est écrit ainsi** : un seul objet Zod sert au type des
arguments, à la validation et au JSON Schema montré au modèle ; les trois
ne peuvent pas diverger. La valeur par défaut `S = z.ZodType` permet
d'écrire `Tool[]` pour des outils aux schémas différents.

## `apps/api/src/tools/datetime.ts`

L'outil `get_current_datetime` : la date et l'heure actuelles, dans un
fuseau choisi.

```ts
  async execute({ timezone = "UTC" }) {
    // Intl rejette les fuseaux inconnus : l'erreur remonte au modèle comme résultat d'outil.
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("fr-FR", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch {
      throw new Error(`Fuseau horaire inconnu : "${timezone}".`);
    }
```

**Ce que fait le code**, dans l'ordre du code :

1. Au-dessus (coupé), le schéma déclare un argument optionnel `timezone`,
   avec un `.describe('Fuseau horaire IANA, par exemple "Europe/Paris"…')`
   que le modèle lit dans le JSON Schema.
2. La déstructuration `{ timezone = "UTC" }` applique la valeur par défaut
   annoncée dans la description.
3. `new Intl.DateTimeFormat(...)` lève une `RangeError` sur un fuseau
   inconnu ; le `catch` la remplace par un message clair, que le registre
   transformera en `{ ok: false }`.
4. Ensuite (coupé), l'outil rend plusieurs représentations du même
   instant : `iso`, `formatted` (date longue en français), `weekday`,
   `timezone` normalisé, `unixSeconds`. Le modèle n'a rien à recalculer.

## `apps/api/src/tools/calculate.ts`

L'outil `calculate` : évalue une expression arithmétique sans jamais
exécuter de JavaScript.

Son schéma (`expression: z.string().trim().min(1, …).max(500, …)`) borne la
longueur avec des messages en français ; `.trim()` est une transformation,
donc l'outil reçoit l'expression déjà nettoyée. Son `execute` appelle
`evaluate(expression)` et rend `{ expression, result }`, pour que le modèle
sache à quoi correspond le nombre.

### La grammaire et `evaluate`

```ts
/*
 * Évaluateur par descente récursive, sans eval ni Function.
 *
 *   expression := terme (("+" | "-") terme)*
 *   terme      := unaire (("*" | "/" | "%") unaire)*
 *   unaire     := "-" unaire | puissance          (-3 ^ 2 vaut -9, comme en maths)
 *   puissance  := primaire ("^" unaire)?          (^ est associatif à droite : 2 ^ 3 ^ 2 = 512)
 *   primaire   := nombre | "(" expression ")"
 */
export function evaluate(source: string): number {
  const parser = new Parser(source);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) {
    throw new Error("Le résultat n'est pas un nombre fini (division par zéro ?).");
  }
  return value;
}
```

**Comment lire la grammaire.** Chaque ligne est une règle, et **chaque
règle devient une méthode** de `Parser`. `*` veut dire « zéro ou plusieurs
fois », `?` « zéro ou une fois », `|` « ou ». Plus une règle est basse,
plus son opérateur est **prioritaire** : `terme` est appelé depuis
`expression`, donc `*` passe avant `+`. Dans `1 + 2 * 3`,
`parseExpression` lit le terme `1`, voit `+`, puis demande un terme entier
à `parseTerm`, qui lit `2 * 3` = 6 avant de rendre la main : total 7.

**Ce que fait `evaluate`** : crée un `Parser` positionné au caractère 0,
lit la plus longue expression possible, puis `expectEnd` vérifie qu'il ne
reste rien (sans lui, `2 3` donnerait 2 en ignorant le `3`). Enfin,
`Number.isFinite` rattrape un résultat infini comme `10 ^ 400`.

### La classe `Parser`

```ts
  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      if (this.consume("+")) value += this.parseTerm();
      else if (this.consume("-")) value -= this.parseTerm();
      else return value;
    }
  }
// …
  private parseUnary(): number {
    if (this.consume("-")) return -this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.consume("^")) return base ** this.parseUnary();
    return base;
  }
```

**Ce que fait le code**, méthode par méthode :

1. **`parseExpression`.** État unique : `position`, l'index du prochain
   caractère. Lit un terme, puis tant que suit `+` ou `-`, le consomme et
   combine avec le terme suivant. La **boucle** rend ces opérateurs
   associatifs à gauche : `10 - 3 - 2` = `(10 - 3) - 2` = 5.
2. **`parseTerm`** (coupé) a la même forme un cran plus bas, avec `*`, `/`
   et `%`. Division et modulo passent par `divide` et `modulo`, qui lèvent
   « Division par zéro. » ou « Modulo par zéro. ».
3. **`parseUnary`.** Si le prochain symbole est `-`, le consomme et
   s'appelle lui-même (`--3` vaut 3). Sinon, délègue à `parsePower`.
4. **`parsePower`.** Lit une base ; si un `^` suit, l'exposant est lu par
   `parseUnary`, qui peut redescendre dans `parsePower`. Cette **récursion**
   rend `^` associatif à droite (`2 ^ 3 ^ 2` = `2 ^ 9` = 512) et autorise
   `2 ^ -1`. Comme le `-` unaire est au-dessus, `-3 ^ 2` = `-(3 ^ 2)` = -9.
5. **`parsePrimary`** (coupé). Une parenthèse ouvrante relance tout depuis le haut
   (`parseExpression`) puis exige `)`. Sinon on avance tant que le
   caractère est un chiffre ou un point, on découpe et on convertit avec
   `Number`. Vide ou `.` seul : « nombre attendu » ; `1.2.3` donne
   `NaN` : « nombre invalide ».

Les utilitaires (non reproduits) : `consume` saute les espaces et avance si
le symbole attendu est là ; `peek` lit le caractère courant ; `fail` lève
`Expression invalide à la position N : raison.` et est typé `never`.

**Pourquoi c'est écrit ainsi** :

- **Sans `eval`.** L'expression vient du modèle, donc indirectement de
  l'utilisateur ; `eval("process.exit()")` arrêterait le serveur. Ici, tout
  caractère hors grammaire provoque une erreur : le parseur ne sait
  produire que des nombres.
- **Une erreur localisée** est une donnée : pour `12 ++* 7`, le modèle
  reçoit la position et la raison, et peut l'expliquer.

## `apps/api/src/tools/registry.ts`

Rassemble les outils, les décrit pour le modèle et les exécute sans jamais
faire échouer la requête.

### `createToolRegistry()`

```ts
export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Outil déclaré deux fois : "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toInputSchema(tool.schema),
      }));
    },
```

**Ce que fait le code** : indexe les outils par nom dans une `Map` (un
doublon lève une erreur **au démarrage**) et rend un objet `ToolRegistry`
où `byName` reste privée par fermeture. `list()` projette chaque outil en
`ToolDescriptor` ; `toInputSchema` appelle `z.toJSONSchema(schema)` et
retire la clé `$schema`. Pour `calculate`, il reste `{ type: "object",
properties: { expression: { type: "string", minLength: 1, maxLength: 500,
description: "…" } }, required: [...] }`.

### `execute()`

```ts
    async execute(name, input, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return failure(`Outil inconnu : "${name}".`);
      }

      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        const details = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
          .join(" ; ");
        return failure(`Arguments invalides. ${details}`);
      }

      // Le délai et l'annulation extérieure se combinent en un seul signal.
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const result = await Promise.race([
          tool.execute(parsed.data, { signal: combined }),
          rejectOnAbort(combined),
        ]);
        return { ok: true, content: JSON.stringify(result) };
      } catch (error) {
        // Une déconnexion du client n'est pas un échec de l'outil : on la laisse remonter.
        if (signal?.aborted) throw error;
        if (timeout.aborted) {
          return failure(`L'outil "${name}" a dépassé le délai de ${timeoutMs} ms.`);
        }
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
```

**Ce que fait le code**, dans l'ordre du code :

1. **Outil inconnu** (nom inventé) : `failure(...)` rend
   `{ ok: false, content: message }`.
2. **Validation** : `safeParse` ne lève pas ; chaque problème Zod devient
   `chemin : message` (`(racine)` si le chemin est vide), joints par ` ; `.
3. **Signaux** : `AbortSignal.timeout` (5 000 ms par défaut) et le signal
   du client sont fusionnés par `AbortSignal.any`.
4. **Course** : `Promise.race` entre l'outil, qui reçoit `parsed.data`
   (validé **et transformé** par Zod), et `rejectOnAbort(combined)`.
   Succès : le résultat est sérialisé en JSON.
5. **Échec**, dans cet ordre : signal **du client** → on relance ; délai
   dépassé → message dédié ; sinon le message de l'erreur de l'outil.

**Pourquoi c'est écrit ainsi** :

- `rejectOnAbort` (en bas du fichier) rend une promesse qui rejette avec
  `signal.reason` dès que le signal se déclenche. Dans la course, elle
  borne aussi un outil qui **ignorerait** son signal : le registre rend la
  main à l'heure, même si l'outil continue en arrière-plan.
- `signal?.aborted` est testé avant `timeout.aborted` : si les deux sont
  vrais, la déconnexion l'emporte, car il n'y a plus personne à qui
  répondre.

## `apps/api/src/tools/index.ts` et `server.ts`

`index.ts` réexporte types, registre et outils : le reste de l'application
importe depuis `tools/index.js`. Le câblage se fait une fois, dans `server.ts` :

```ts
// Les outils sont déclarés ici, au démarrage : la route ne connaît que le registre.
const tools = createToolRegistry([getCurrentDatetimeTool, calculateTool]);
```

Ajouter un outil : un fichier dans `tools/`, un export, une entrée dans ce
tableau. La route ne change pas.

## `apps/api/src/routes/chat.ts`

La route `POST /api/chat` : validation, flux SSE, puis la boucle d'outils.

### L'appel à la boucle

Le handler appelle `runConversation` après l'ouverture du flux SSE, en lui
passant tout dans un objet : client LLM, registre, prompt système,
historique, drapeau `debug` (champ optionnel du corps), signal, flux SSE,
logger. `true` → la route envoie `done` ; `false` → log `warn` « trop de
tours d'outils » et `error` avec `TOO_MANY_TURNS_MESSAGE`. Une exception
(panne, déconnexion relancée par le registre) part dans le `catch` vu au
cours précédent.

*La recherche documentaire faite avant (`searchDocuments`, événement
`sources`) et le prompt de `buildRagPrompt` ont été ajoutés au jour 2 : voir
[l'approfondissement de la réponse sourcée](jour-2-recherche-reponse.md).*

### `runConversation` : la boucle

```ts
async function runConversation({ llm, tools, system, messages, debug, signal, sse, log }: ConversationContext) {
  const history: ChatMessage[] = [...messages];
  const toolDefinitions = tools.list();

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    let text = "";
    const toolCalls: ToolCall[] = [];

    const params = { system, messages: history, tools: toolDefinitions };
// …
    const stream = llm.streamChat({ ...params, signal });
    for await (const event of stream) {
      if (event.type === "text") {
        text += event.text;
        sse.send({ event: "delta", data: { text: event.text } });
      } else {
        toolCalls.push(event);
      }
    }

// …
    // Pas d'appel d'outil : la réponse est finale.
    if (toolCalls.length === 0) return true;

    log.info({ turn, toolCalls: toolCalls.length }, "appels d'outils demandés");

    // Le message assistant est renvoyé tel quel au tour suivant, texte et appels compris.
    // Le fournisseur refuse un bloc texte vide : on ne l'ajoute que s'il y a du texte.
    const assistantParts: ContentPart[] = toolCalls.map((call) => ({
      type: "tool_call",
      id: call.id,
      name: call.name,
      input: call.input,
    }));
    if (text.trim() !== "") assistantParts.unshift({ type: "text", text });
    history.push({ role: "assistant", content: assistantParts });

    // Les outils d'un même tour sont indépendants : exécution en parallèle.
    const results = await Promise.all(
      toolCalls.map((call) => executeToolCall(call, { tools, signal, sse, log })),
    );
    history.push({ role: "user", content: results });
  }

  return false;
}
```

**Ce que fait le code**, dans l'ordre du code :

1. `history` est une **copie** ; `tools.list()` est calculé une seule fois.
2. Au plus `MAX_TOOL_TURNS` (5) tours, un tour = un appel au modèle.
3. **Debug** (coupé). Si `debug` est vrai, un événement `model_request`
   envoie `params` avant l'appel (avec `structuredClone(history)`, une
   copie figée), et un `model_response` envoie `{ text, toolCalls }` après.
4. **Lecture du flux.** Un `text` est accumulé **et** envoyé tout de suite
   en `delta`. Un `tool_call` est mis de côté jusqu'à la fin du tour.
5. **Condition d'arrêt.** Aucun appel : le modèle a conclu, on rend `true`.
6. Sinon, log `info` (numéro du tour, **nombre** d'appels), puis on
   reconstruit le message assistant : un `tool_call` par appel, précédé du
   texte s'il n'est pas vide (`unshift`).
7. `Promise.all` exécute tous les appels en parallèle ; les résultats
   arrivent **dans l'ordre** des appels et forment un seul message `user`.
8. Cinq tours sans conclusion : on sort de la boucle et on rend `false`.

**Pourquoi c'est écrit ainsi** :

- `text` est accumulé alors qu'il est déjà parti au navigateur : le
  fournisseur exige qu'on lui renvoie son propre message assistant, texte
  compris, avant les résultats.
- `Promise.all` ne rejette que si un `executeToolCall` rejette, c'est-à-dire
  en cas de déconnexion : le registre transforme tout le reste en résultat.

### `executeToolCall` : un appel, deux événements

```ts
  sse.send({ event: "tool_call", data: { name: call.name, input: call.input } });

  const startedAt = performance.now();
  const result = await tools.execute(call.name, call.input, { signal, timeoutMs: TOOL_TIMEOUT_MS });
  const durationMs = Math.round(performance.now() - startedAt);

  // Nom et durée seulement : ni les arguments ni le résultat.
  log.info({ tool: call.name, durationMs, ok: result.ok }, "outil exécuté");
  sse.send({ event: "tool_result", data: { name: call.name, ok: result.ok } });

  return { type: "tool_result", toolCallId: call.id, content: result.content, isError: !result.ok };
```

**Ce que fait le code** :

1. `ToolCall` est `Extract<LlmEvent, { type: "tool_call" }>`, la variante
   appel de `LlmEvent`.
2. Envoie `tool_call` **avant** l'exécution : la ligne « en cours »
   apparaît tout de suite.
3. Exécute via le registre (signal du client, `TOOL_TIMEOUT_MS`), mesure
   la durée, logue nom, durée et `ok`, jamais arguments ni résultat.
4. Envoie `tool_result` (nom et `ok` seulement : le contenu ne va qu'au
   modèle), puis rend le `ContentPart` avec `toolCallId` = `call.id`.

Ces événements sont déclarés dans l'union `SseEvent` de
`apps/api/src/sse.ts` (`tool_call`, `tool_result`, `debug`) : `sse.send`
est typé par elle, un `tool_result` sans `ok` ne compilerait pas.

## `apps/web/src/chat/types.ts`

```ts
/** Un appel d'outil observé pendant une réponse. `ok` reste indéfini tant que l'outil tourne. */
export type ToolActivity = {
  name: string;
  input: unknown;
  ok?: boolean;
};
```

`ToolActivity` est une ligne d'affichage. Le champ optionnel `ok` encode
trois états : absent (en cours), `true`, `false`. `UiMessage` (même
fichier) étend `ChatMessage` avec `tools?: ToolActivity[]`, alors que le
`ChatMessage` du navigateur n'a qu'un `content: string`. Deux types pour
deux usages : ce que React affiche, et ce qui part au serveur.

## `apps/web/src/chat/api.ts`

```ts
          case "tool_call": {
            const { name, input } = parseJson<{ name: string; input: unknown }>(event.data);
            handlers.onToolCall(name, input);
            break;
          }
          case "tool_result": {
            const { name, ok } = parseJson<{ name: string; ok: boolean }>(event.data);
            handlers.onToolResult(name, ok);
            break;
          }
```

**Ce que fait le code** :

1. Chaque `case` parse le champ `data` et appelle son handler.
2. Le `case "debug"` qui suit (coupé) appelle `handlers.onDebug?.(…)` :
   `onDebug` est optionnel, contrairement aux deux autres.
3. Plus haut, le corps envoyé contient `debug: handlers.onDebug !== undefined` :
   le serveur n'émet `debug` que si l'appelant sait le traiter.

## `apps/web/src/chat/useChat.ts`

### Les handlers branchés dans `run`

```ts
        onToolCall: (name, input) =>
          setMessages((prev) =>
            updateLastAssistant(prev, (m) => ({ ...m, tools: [...(m.tools ?? []), { name, input }] })),
          ),
        onToolResult: (name, ok) =>
          setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, tools: markToolResult(m.tools, name, ok) }))),
```

**Ce que fait le code** :

1. `onToolCall` ajoute à la dernière bulle assistant une `ToolActivity`
   **sans `ok`** (« en cours ») ; `onToolResult` délègue à `markToolResult`.
2. Les deux utilisent `setMessages((prev) => …)` : les événements arrivent
   en rafale, chaque mise à jour doit partir du dernier état.
3. Juste au-dessus, `onDebug` ajoute au journal une ligne de famille
   `model` (« → envoyé au modèle (tour 2) »), avec le `payload` en arbre.

### `markToolResult` et `toWireHistory`

```ts
/** Marque comme terminé le premier appel encore en cours portant ce nom. */
function markToolResult(tools: UiMessage["tools"], name: string, ok: boolean) {
  if (!tools) return tools;
  const index = tools.findIndex((tool) => tool.name === name && tool.ok === undefined);
  if (index === -1) return tools;
  return tools.map((tool, i) => (i === index ? { ...tool, ok } : tool));
}
```

**Ce que fait le code** :

1. `toWireHistory` (plus haut, montrée dans le cours) ne garde que `role`
   et `content` : `tools` et `sources` ne quittent jamais le navigateur.
2. `markToolResult` cherche le **premier** appel de ce nom encore en cours.
   S'il n'y en a pas, rien ne change ; sinon il rend un nouveau tableau où
   seul cet élément reçoit `ok`.

**Pourquoi c'est écrit ainsi** :

- Le SSE ne transporte pas l'`id` de l'appel, donc on apparie par nom. Avec
  deux `calculate` en parallèle, le premier résultat arrivé peut marquer la
  mauvaise ligne : approximation acceptée pour un affichage.
- Ne renvoyer que du texte empêche un client d'inventer des `tool_result`.
  Contrepartie : à la question suivante, le modèle ne voit pas les
  résultats bruts et rappelle l'outil si besoin.

## `apps/web/src/chat/ToolActivityLine.tsx`

```tsx
export function ToolActivityLine({ activity }: ToolActivityLineProps) {
  const state = activity.ok === undefined ? "pending" : activity.ok ? "ok" : "failed";
  const label = { pending: "en cours", ok: "succès", failed: "échec" }[state];

  return (
    <div className={`tool-activity tool-activity--${state}`} title={`${activity.name} : ${label}`}>
      <span className="tool-activity__icon" aria-hidden="true" />
      <code className="tool-activity__name">{activity.name}</code>
      <code className="tool-activity__input">{formatInput(activity.input)}</code>
      <span className="tool-activity__state">{label}</span>
    </div>
  );
}
```

**Ce que fait le code** :

1. Traduit `ok` en un état (`pending`, `ok`, `failed`) puis en libellé.
2. L'état devient une classe CSS que `chat.css` anime ou colore ;
   `aria-hidden` cache le point décoratif aux lecteurs d'écran.
3. `formatInput` (en dessous) sérialise les arguments et tronque à 120
   caractères. `MessageBubble.tsx` affiche une ligne par élément de
   `message.tools`, au-dessus du texte.

## Pour explorer toi-même

- **Le flux brut.** Avec les serveurs lancés :
  `curl -N -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Combien font 1234 * 5678 ?"}]}'`.
  Ajoute `"debug":true` au corps pour voir aussi les événements `debug`.
- **Le journal de l'interface.** Filtre la famille `model` : la ligne
  « → envoyé au modèle (tour 2) » montre le message assistant avec son
  `tool_call` puis le message user avec son `tool_result`, et leurs `id`
  identiques.
- **Le parseur seul.** Depuis `apps/api`, sans serveur :
  `npx tsx -e 'import("./src/tools/calculate.ts").then(m => { for (const e of ["2 ^ 3 ^ 2", "-3 ^ 2", "10 - 3 - 2", "12 ++* 7"]) { try { console.log(e, "=", m.evaluate(e)); } catch (err) { console.log(e, "->", err.message); } } })'`.
- **Les fragments JSON.** Un `console.log(event.index, event.delta.partial_json)`
  temporaire dans la branche `input_json_delta` de `anthropic.ts`.
- **Le délai.** Ajoute temporairement
  `await new Promise((r) => setTimeout(r, 6000));` au début de
  `calculateTool.execute` : la ligne passe en rouge et le modèle reçoit
  « a dépassé le délai de 5000 ms ».
- **Le plafond.** Passe temporairement `MAX_TOOL_TURNS` à `1` : toute
  question qui appelle un outil se termine par l'événement `error` « trop
  d'appels d'outils sans conclure ».
