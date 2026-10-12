# Cours : donner des outils à un chatbot (tool use)

> **Prérequis.** Avoir suivi le cours précédent, `flux-dun-message.md`. On y
> a construit un chatbot en streaming : `useChat` → `POST /api/chat` →
> `LlmClient.streamChat` → Anthropic, avec des événements SSE `delta`, `done`
> et `error`. Ce cours part de cet état et ajoute une seule capacité :
> le modèle peut **demander l'exécution de fonctions** que nous écrivons.
>
> **Le fil rouge.** Un seul message, « Quel jour serons-nous dans 45 jours ? »,
> que le modèle ne peut pas traiter seul : il ne connaît pas la date du jour.
> Nous le suivrons jusqu'à la réponse « jeudi 26 novembre 2026 ».

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'est-ce que le tool use, et qu'avons-nous construit ? |
| 1 | Comment décrire une conversation avec outils sans dépendre d'un fournisseur ? |
| 2 | Comment traduire ce format vers Anthropic, et reconstituer un appel en streaming ? |
| 3 | Comment écrire un outil que le modèle saura utiliser ? |
| 4 | Comment exécuter un outil sans jamais faire échouer la requête ? |
| 5 | La boucle : que fait le serveur entre deux appels au modèle ? |
| 6 | Comment le navigateur affiche-t-il les appels sans les mémoriser ? |
| 7 | Que se passe-t-il quand ça se passe mal ? |
| 8 | Synthèse, vérifications manuelles et corrigé |

---

## Leçon 0 : qu'est-ce que le tool use ?

### L'idée en une phrase

Un modèle de langage ne sait que produire du texte. Le **tool use** consiste à
lui décrire des fonctions disponibles, à le laisser *demander* qu'on en
appelle une avec certains arguments, à l'exécuter nous-mêmes, puis à lui
renvoyer le résultat pour qu'il continue.

Trois points à bien fixer dès maintenant, parce qu'ils déterminent tout le
code :

1. **Le modèle n'exécute rien.** Il émet un bloc structuré « appelle
   `calculate` avec `{"expression": "1234 * 5678"}` ». C'est notre serveur
   qui exécute, et qui décide s'il veut bien le faire.
2. **Un appel d'outil est un aller-retour.** Après l'exécution, il faut
   rappeler le modèle avec le résultat. Une question peut donc coûter deux,
   trois appels au modèle. C'est une **boucle**, et une boucle a besoin d'une
   condition d'arrêt.
3. **Le modèle choisit tout seul.** Nous décrivons les outils, il décide s'il
   en a besoin. « Bonjour » n'en appelle aucun ; « quel jour dans 45 jours ? »
   appelle la date. La qualité de la description de l'outil est donc une
   partie du programme.

### Le voyage du message, vu de haut

```
navigateur            serveur (/api/chat)                 modèle
    │  POST {messages}       │                               │
    │───────────────────────▶│  tour 1 : messages + outils   │
    │                        │──────────────────────────────▶│
    │                        │◀── tool_call get_current_datetime
    │◀── SSE tool_call ──────│                               │
    │                        │  exécute l'outil (serveur)    │
    │◀── SSE tool_result ────│                               │
    │                        │  tour 2 : + appel + résultat  │
    │                        │──────────────────────────────▶│
    │◀── SSE delta × n ──────│◀── texte « jeudi 26 novembre »│
    │◀── SSE done ───────────│                               │
```

### Ce que nous avons ajouté

```
apps/api/src/
├── llm/
│   ├── types.ts        ← format neutre : ContentPart, ToolDefinition, LlmEvent   (Leçon 1)
│   ├── anthropic.ts    ← traduction vers le SDK, reconstitution des tool_use      (Leçon 2)
│   └── index.ts
├── tools/              ← NOUVEAU, ne connaît ni le LLM ni Fastify
│   ├── types.ts        ← Tool, ToolContext, ToolDescriptor, ToolExecutionResult  (Leçon 3)
│   ├── datetime.ts     ← get_current_datetime                                     (Leçon 3)
│   ├── calculate.ts    ← calculate, avec son évaluateur sans eval                 (Leçon 3)
│   ├── registry.ts     ← createToolRegistry : list() et execute()                 (Leçon 4)
│   └── index.ts
├── routes/chat.ts      ← la boucle d'outils                                        (Leçon 5)
├── sse.ts              ← deux événements de plus : tool_call, tool_result          (Leçon 5)
├── prompts/system.ts   ← une phrase de plus
└── server.ts           ← crée le registre et le passe à la route

apps/web/src/chat/
├── types.ts            ← ToolActivity, UiMessage                                   (Leçon 6)
├── api.ts              ← trois callbacks au lieu d'un                              (Leçon 6)
├── useChat.ts          ← gère tool_call / tool_result, projette en texte seul      (Leçon 6)
├── ToolActivityLine.tsx← NOUVEAU : une ligne par outil appelé                      (Leçon 6)
└── MessageBubble.tsx   ← affiche les lignes au-dessus du Markdown
```

Ce qui n'a **pas** changé : `config.ts`, `sse.ts` (hormis l'union de types),
le parseur SSE du navigateur, `Composer`, `ErrorBanner`, `MessageList`. Quand
une architecture est bien découpée, ajouter une capacité touche peu de
fichiers, et chacun pour une raison claire.

> **À retenir**
> Le tool use est une boucle : décrire → le modèle demande → nous exécutons
> → nous renvoyons le résultat → le modèle conclut. Le modèle n'exécute
> jamais rien lui-même.

**Questions**
1. Pourquoi le modèle a-t-il besoin d'un outil pour connaître la date, alors
   qu'il « sait » tant de choses ?
2. Qu'est-ce qui empêche un utilisateur malveillant de faire exécuter
   n'importe quoi au serveur via un appel d'outil ?

---

## Leçon 1 : un format neutre pour une conversation avec outils

### Le problème

Jusqu'ici, un message était `{ role, content: string }`. Avec les outils, un
message assistant peut contenir *du texte et des demandes d'appel*, et un
message utilisateur peut contenir *des résultats d'outils*. Chaque
fournisseur a sa propre façon d'écrire cela. Si nous copions la forme
d'Anthropic dans toute l'application, changer de fournisseur un jour
voudra dire réécrire la route, le front, les tests.

La réponse est la même qu'au cours précédent avec `LlmClient` : nous
définissons **notre** format, et un seul fichier sait le traduire.

### Le code : `llm/types.ts`

```ts
export type ContentPart =
  | { type: "text"; text: string }
  /** L'assistant demande l'exécution d'un outil. Uniquement dans un message "assistant". */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** Le résultat d'un appel d'outil, renvoyé au modèle. Uniquement dans un message "user". */
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

export type ChatMessage = {
  role: "user" | "assistant";
  content: string | ContentPart[];
};
```

Lisons-le comme un contrat.

- Un message est une liste de **morceaux** (`ContentPart`). Le cas
  `content: string` est conservé comme raccourci : tout le code existant
  (le script `hello`, les messages du navigateur) continue de compiler.
- Un `tool_call` porte un **`id`**. C'est indispensable : si le modèle
  demande deux calculs dans le même tour, il faut pouvoir dire quel
  résultat répond à quelle demande. Le `tool_result` reprend cet id dans
  `toolCallId`.
- `input` est `unknown`, pas `any`. Le modèle produit du JSON de forme libre ;
  c'est au registre (Leçon 4) de le valider avant usage. Le type dit
  honnêtement « on ne sait pas encore ».
- `isError` est un booléen séparé du contenu. Un outil qui échoue renvoie
  quand même un résultat, et le modèle doit savoir que c'en est un raté.

Les deux commentaires « uniquement dans un message assistant / user » sont
des **règles du fournisseur** que notre format porte sans les imposer par le
type. C'est un compromis : un type plus strict (deux types de messages
distincts) aurait alourdi tout le code pour une erreur que seul le serveur
peut commettre, et qu'il ne commet pas.

### Ce que le modèle reçoit et ce qu'il émet

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) d'un objet : les arguments de l'outil. */
  inputSchema: Record<string, unknown>;
}

export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown };

export interface LlmClient {
  streamChat(params: StreamChatParams): AsyncIterable<LlmEvent>;
}
```

Le changement le plus visible : `streamChat` ne rend plus des `string` mais
des **événements**. Un fragment de texte en est un, une demande d'outil en
est un autre. Le consommateur (la route) fait un `switch` sur `type`. Notez
que `tool_call` arrive **complet**, arguments déjà parsés : c'est
l'implémentation qui a fait le travail de reconstitution (Leçon 2). Le
consommateur n'a pas à savoir que le JSON est arrivé en morceaux.

> **À retenir**
> Notre format : des messages faits de morceaux `text`, `tool_call` (avec
> id) et `tool_result` (avec le même id). Le client LLM émet des événements
> `text` ou `tool_call`. Rien de tout cela ne vient du SDK.

**Questions**
1. Pourquoi `tool_call` a-t-il besoin d'un `id` alors que le nom de l'outil
   suffirait à l'identifier dans la plupart des cas ?
2. Que se passerait-il si `input` était typé `Record<string, string>` au lieu
   de `unknown` ?

---

## Leçon 2 : traduire vers Anthropic, et reconstituer un appel en streaming

### La correspondance, terme à terme

C'est l'en-tête de `llm/anthropic.ts`, recopié ici parce que c'est la pièce
centrale de la leçon :

| Notre format | Anthropic |
| --- | --- |
| `ToolDefinition { name, description, inputSchema }` | `tools: [{ name, description, input_schema }]` |
| part `text` | bloc `{ type: "text", text }` |
| part `tool_call { id, name, input }` (message assistant) | bloc `{ type: "tool_use", id, name, input }` |
| part `tool_result { toolCallId, content, isError }` (message user) | bloc `{ type: "tool_result", tool_use_id, content, is_error }` |

Et dans l'autre sens, pour le flux reçu :

| Événement du SDK | Ce qu'on en fait |
| --- | --- |
| `content_block_delta` avec `delta.type === "text_delta"` | événement `{ type: "text" }` |
| `content_block_start` dont `content_block.type === "tool_use"` | on retient `id` et `name`, on ouvre un tampon JSON vide |
| `content_block_delta` avec `delta.type === "input_json_delta"` | on ajoute `partial_json` au tampon |
| `content_block_stop` | `JSON.parse(tampon)` → événement `{ type: "tool_call" }` |

Les trois fonctions de traduction sont triviales, et c'est voulu :

```ts
function toAnthropicBlock(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: part.toolCallId, content: part.content, is_error: part.isError };
  }
}
```

Un `switch` exhaustif : si on ajoute un quatrième type de `ContentPart`
demain, TypeScript refusera de compiler ce fichier tant qu'on n'aura pas
dit comment le traduire. C'est le genre d'erreur qu'on veut à la
compilation, pas en production.

### Le point délicat : un appel d'outil arrive en morceaux

Quand le modèle demande un outil en streaming, le SDK n'envoie pas un
événement unique. Il envoie :

```
content_block_start   { index: 1, content_block: { type: "tool_use", id: "toolu_01…", name: "calculate", input: {} } }
content_block_delta   { index: 1, delta: { type: "input_json_delta", partial_json: '{"expr' } }
content_block_delta   { index: 1, delta: { type: "input_json_delta", partial_json: 'ession": "1234' } }
content_block_delta   { index: 1, delta: { type: "input_json_delta", partial_json: ' * 5678"}' } }
content_block_stop    { index: 1 }
```

Le `start` donne l'identité, les `delta` donnent les arguments *en
fragments de JSON*, le `stop` dit que c'est fini. Et comme une réponse peut
contenir plusieurs blocs (du texte à l'index 0, un outil à l'index 1, un
autre à l'index 2), chaque événement porte un `index`.

Le code qui reconstitue :

```ts
const pendingToolCalls = new Map<number, { id: string; name: string; json: string }>();

for await (const event of stream) {
  switch (event.type) {
    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        pendingToolCalls.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
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

Reconnaissez-vous le motif ? C'est **exactement le parseur SSE du cours
précédent** : un tampon par unité en cours, on accumule, on n'émet que
quand l'unité est complète. Ici l'unité est un bloc, la clé est l'index, le
signal de fin est `content_block_stop`. Chaque couche de la chaîne recolle
ce que la couche du dessous a coupé.

Le cas `pending.json === ""` est le genre de détail qu'on ne trouve qu'en
lisant les événements réels : pour `get_current_datetime` appelé sans
fuseau, le modèle n'émet aucun `input_json_delta`. `JSON.parse("")` aurait
levé une exception.

### Et le `max_tokens`, le refus ?

Rien ne change : `stream.finalMessage()` est toujours attendu après la
boucle, et un `stop_reason === "refusal"` lève toujours une erreur. Le
`stop_reason` vaut `"tool_use"` quand le modèle a demandé des outils, mais
nous n'en avons pas besoin : la route sait qu'il y a des appels parce
qu'elle a reçu des événements `tool_call`.

> **À retenir**
> La traduction est un `switch` exhaustif par type de morceau. En streaming,
> un appel d'outil arrive en `start` / `delta` × n / `stop`, indexé par bloc :
> on le reconstitue avec un tampon, comme le parseur SSE.

**Questions**
1. Pourquoi indexer les appels en cours par `event.index` plutôt que de
   garder une seule variable « appel en cours » ?
2. Qu'arriverait-il si on faisait `JSON.parse` à chaque `input_json_delta`
   au lieu d'attendre `content_block_stop` ?

---

## Leçon 3 : écrire un outil que le modèle saura utiliser

### Le contrat d'un outil

```ts
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute(input: z.infer<S>, context: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  signal: AbortSignal;
}
```

Quatre champs, et chacun a un destinataire différent :

- `name` et `description` sont **pour le modèle**. Il ne verra rien d'autre.
- `schema` sert **deux fois** : il est converti en JSON Schema pour le modèle
  (qui apprend ainsi quels arguments produire), et il valide ce que le
  modèle a réellement produit avant l'exécution.
- `execute` est **pour nous**. Grâce à `z.infer<S>`, son paramètre `input`
  est typé d'après le schéma : dans `calculate`, `input.expression` est une
  `string`, garanti.

Le `signal` dans le contexte permet à un outil long d'être interrompu. Nos
deux outils sont instantanés et l'ignorent, mais le contrat est là pour le
jour où un outil fera un appel réseau.

### La description est du code

Regardez celle de `get_current_datetime` :

```ts
description:
  "Donne la date et l'heure actuelles. À utiliser pour toute question qui dépend " +
  "d'aujourd'hui (quel jour sommes-nous, dans combien de jours, quelle heure est-il…) " +
  "plutôt que de deviner.",
```

Elle ne dit pas seulement *ce que fait* l'outil, elle dit *quand* l'utiliser,
avec des exemples de formulations, et *quoi ne pas faire* (« plutôt que de
deviner »). Un modèle lit cette phrase à chaque requête. Une description
vague (« renvoie la date ») donne un modèle qui estime la date de tête une
fois sur trois. Une description précise donne un comportement stable. Le
prompt système ajoute une phrase dans le même sens, à portée générale.

Le `.describe()` sur les champs Zod joue le même rôle pour chaque argument :

```ts
timezone: z.string().optional().describe('Fuseau horaire IANA, par exemple "Europe/Paris". Par défaut : UTC.'),
```

Ce texte se retrouve dans le JSON Schema, champ `description`. C'est grâce
à lui que le modèle a envoyé `"Europe/Paris"` pour un utilisateur qui écrit
en français, sans qu'on lui ait rien demandé.

### `get_current_datetime` : rejeter proprement un fuseau inconnu

```ts
async execute({ timezone = "UTC" }) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("fr-FR", { timeZone: timezone, dateStyle: "full", timeStyle: "long" });
  } catch {
    throw new Error(`Fuseau horaire inconnu : "${timezone}".`);
  }
  const now = new Date();
  return {
    iso: now.toISOString(),
    formatted: formatter.format(now),
    weekday: …,
    timezone: formatter.resolvedOptions().timeZone,
    unixSeconds: Math.floor(now.getTime() / 1000),
  };
}
```

Deux choix à remarquer. D'abord, l'outil renvoie **plusieurs
représentations** de la même information (ISO, texte en français, jour de
la semaine, timestamp). Le modèle choisit celle qui l'aide : pour « dans 45
jours », le jour de la semaine et la date formatée lui ont suffi à raisonner
juste. Ensuite, l'erreur de fuseau est **relancée avec un message à nous**,
pas celui de `Intl` (« Invalid time zone specified »). Ce message sera lu par
le modèle, puis reformulé à l'utilisateur ; autant qu'il soit clair.

### `calculate` : évaluer sans `eval`

Pourquoi pas `eval("1234 * 5678")` ? Parce que la chaîne vient du modèle,
qui la construit à partir du message de l'utilisateur. Un utilisateur qui
écrit « calcule `process.exit()` » pourrait faire passer cette chaîne
jusqu'à `eval`. Même sans malveillance, `eval` accepte tout JavaScript,
donc l'outil ne ferait pas « de l'arithmétique » mais « du code
arbitraire ». La règle : **jamais d'interprétation de code sur une entrée
que nous ne contrôlons pas.**

À la place, un évaluateur par **descente récursive**, soixante lignes, qui
ne connaît que les nombres et sept opérateurs. Sa grammaire :

```
expression := terme (("+" | "-") terme)*
terme      := unaire (("*" | "/" | "%") unaire)*
unaire     := "-" unaire | puissance          (-3 ^ 2 vaut -9, comme en maths)
puissance  := primaire ("^" unaire)?          (^ est associatif à droite : 2 ^ 3 ^ 2 = 512)
primaire   := nombre | "(" expression ")"
```

Chaque ligne de la grammaire est une méthode du `Parser`, et l'ordre des
lignes encode la **priorité** des opérateurs : `expression` appelle `terme`,
qui appelle `unaire`, qui appelle `puissance`. Plus une règle est profonde,
plus elle « colle » fort. C'est ainsi que `1 + 2 * 3` donne 7 : `terme`
consomme `2 * 3` avant de rendre la main à `expression`.

```ts
private parseTerm(): number {
  let value = this.parseUnary();
  for (;;) {
    if (this.consume("*")) value *= this.parseUnary();
    else if (this.consume("/")) value = this.divide(value, this.parseUnary());
    else if (this.consume("%")) value = this.modulo(value, this.parseUnary());
    else return value;
  }
}
```

Et les erreurs sont **localisées** :

```ts
private fail(reason: string): never {
  throw new Error(`Expression invalide à la position ${this.position + 1} : ${reason}.`);
}
```

Pour `12 ++* 7`, l'outil répond « Expression invalide à la position 5 :
nombre attendu. ». Le modèle a su, à partir de ce seul message, expliquer à
l'utilisateur que le `*` ne pouvait pas suivre un `+`. Un message d'erreur
précis est une donnée que le modèle exploite.

> **À retenir**
> Un outil, c'est un nom, une description écrite pour le modèle, un schéma
> Zod qui sert à la fois à décrire et à valider, et une fonction typée.
> Jamais d'`eval` sur une entrée venue du modèle.

**Questions**
1. Le modèle a envoyé `"Europe/Paris"` sans qu'on le lui demande. D'où
   tient-il cette idée ?
2. Pourquoi `-3 ^ 2` doit-il valoir -9 et pas 9, et où dans la grammaire
   cette décision est-elle prise ?

---

## Leçon 4 : le registre, ou comment ne jamais faire échouer la requête

### Le contrat

```ts
export interface ToolRegistry {
  list(): ToolDescriptor[];
  execute(name: string, input: unknown, options?: ExecuteOptions): Promise<ToolExecutionResult>;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
}
```

La phrase clé est dans le commentaire du code : « **Ne lève jamais** : toute
erreur devient `{ ok: false }` ». Pourquoi est-ce si important ?

Parce qu'un outil qui échoue n'est pas une panne du serveur. C'est une
information pour le modèle : « ce fuseau n'existe pas », « cette expression
est mal formée ». Si l'exception remontait jusqu'à la route, celle-ci
enverrait un événement `error`, l'interface afficherait « La génération a
échoué », et l'utilisateur ne saurait jamais que c'est son expression qui
était fausse. En transformant l'échec en résultat, on laisse le modèle
l'expliquer, ce qu'il fait très bien.

### Les quatre façons d'échouer, et leur traitement

```ts
async execute(name, input, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const tool = byName.get(name);
  if (!tool) return failure(`Outil inconnu : "${name}".`);                 // 1

  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return failure(`Arguments invalides. ${details}`);  // 2

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const result = await Promise.race([
      tool.execute(parsed.data, { signal: combined }),
      rejectOnAbort(combined),
    ]);
    return { ok: true, content: JSON.stringify(result) };
  } catch (error) {
    if (signal?.aborted) throw error;                                      // déconnexion : on laisse remonter
    if (timeout.aborted) return failure(`L'outil "${name}" a dépassé le délai de ${timeoutMs} ms.`); // 3
    return failure(error instanceof Error ? error.message : String(error)); // 4
  }
}
```

1. **Outil inconnu.** Le modèle a inventé un nom. Rare, mais possible.
2. **Arguments invalides.** Le schéma Zod refuse. Le message liste les
   problèmes (`expression : Invalid input: expected string, received
   undefined`), et le modèle réessaie en général avec les bons arguments.
3. **Délai dépassé.** Voir ci-dessous.
4. **L'outil a levé.** Division par zéro, fuseau inconnu : le message de
   l'erreur devient le contenu du résultat.

Et une cinquième issue qui n'est **pas** un échec d'outil : le client s'est
déconnecté (`signal.aborted`). Là, on relance l'exception, parce que ce
n'est plus la peine de continuer quoi que ce soit ; la route la rattrape et
logue « client déconnecté » comme avant.

### Combiner un délai et une annulation

```ts
const timeout = AbortSignal.timeout(timeoutMs);
const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
```

Deux raisons d'arrêter un outil : le client est parti, ou l'outil est trop
lent. `AbortSignal.any` fabrique un signal qui se déclenche dès que l'un des
deux se déclenche. On passe ce signal combiné à l'outil, et on garde les
deux originaux pour savoir *lequel* a déclenché, dans le `catch`.

`Promise.race` avec `rejectOnAbort` est une ceinture en plus des bretelles :
un outil mal écrit qui ignore son `signal` serait quand même abandonné à
l'échéance. Sa promesse continuerait en arrière-plan, mais la requête,
elle, n'attend plus.

### Zod → JSON Schema

```ts
function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema);
  return rest;
}
```

Zod 4 sait produire un JSON Schema standard depuis un schéma. C'est ce qui
permet d'écrire le schéma **une seule fois** et de l'utiliser pour décrire
(au modèle) et pour valider (à l'exécution). Les deux ne peuvent plus
diverger.

### L'indépendance du registre

`tools/` n'importe rien de `llm/` ni de `fastify`. Son `ToolDescriptor` a la
même forme que `ToolDefinition` du LLM, mais ce sont deux types déclarés
séparément : TypeScript les accepte l'un pour l'autre parce qu'ils sont
**structurellement** identiques, sans qu'un module dépende de l'autre. Le
jour où tu brancheras une autre source d'outils (un serveur MCP, par
exemple), tu l'adapteras à l'interface `Tool` et le reste ne bougera pas.

> **À retenir**
> Le registre transforme tout échec en résultat `{ ok: false }` lisible par
> le modèle, sauf la déconnexion du client. Délai et annulation se
> combinent avec `AbortSignal.any`. Le schéma Zod décrit et valide.

**Questions**
1. Pourquoi la déconnexion du client est-elle le seul cas où `execute`
   relance une exception ?
2. Que gagne-t-on à générer le JSON Schema depuis Zod plutôt qu'à l'écrire
   à la main à côté ?

---

## Leçon 5 : la boucle

### Ce qui change dans la route

La validation Zod, le `hijack`, l'`AbortController` relié à la fermeture de
la connexion, le `catch` et le `finally` : tout cela est identique au cours
précédent. Ce qui change, c'est qu'entre l'ouverture du flux et le `done`, il
n'y a plus « un appel au modèle » mais **`runConversation`**.

```ts
async function runConversation({ llm, tools, messages, signal, sse, log }: ConversationContext) {
  const history: ChatMessage[] = [...messages];
  const toolDefinitions = tools.list();

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    let text = "";
    const toolCalls: ToolCall[] = [];

    const stream = llm.streamChat({ system: SYSTEM_PROMPT, messages: history, tools: toolDefinitions, signal });
    for await (const event of stream) {
      if (event.type === "text") {
        text += event.text;
        sse.send({ event: "delta", data: { text: event.text } });
      } else {
        toolCalls.push(event);
      }
    }

    if (toolCalls.length === 0) return true;          // réponse finale

    …                                                  // sinon : exécuter, enrichir l'historique, repartir
  }

  return false;                                        // plafond atteint
}
```

Suivons un tour.

1. On appelle le modèle avec **l'historique de travail** `history`, qui
   commence par les messages du client et s'allonge à chaque tour.
2. Les événements `text` partent **immédiatement** en SSE, exactement
   comme avant. Le streaming n'est pas sacrifié. Ils sont aussi accumulés
   dans `text`, parce qu'on en aura besoin si le tour demande des outils.
3. Les événements `tool_call` sont collectés, pas traités tout de suite : on
   attend la fin du tour pour avoir tous les appels.
4. **Condition d'arrêt** : aucun appel d'outil, le modèle a conclu. On rend
   `true`, et la route envoie `done`.

### Enrichir l'historique

```ts
const assistantParts: ContentPart[] = toolCalls.map((call) => ({
  type: "tool_call", id: call.id, name: call.name, input: call.input,
}));
if (text.trim() !== "") assistantParts.unshift({ type: "text", text });
history.push({ role: "assistant", content: assistantParts });

const results = await Promise.all(
  toolCalls.map((call) => executeToolCall(call, { tools, signal, sse, log })),
);
history.push({ role: "user", content: results });
```

C'est ici que les règles de la Leçon 1 prennent vie. On ajoute **deux
messages** : le message assistant tel que le modèle l'a produit (son texte
éventuel, puis ses appels), puis un message user qui contient les
résultats. Au tour suivant, le modèle relit toute cette séquence et sait
qu'il avait demandé `calculate`, et ce que `calculate` a répondu.

Le `text.trim() !== ""` évite d'envoyer un bloc texte vide, que le
fournisseur refuse. Quand le modèle appelle un outil sans rien dire avant,
`text` est vide.

`Promise.all` : les appels d'un même tour s'exécutent **en parallèle**. Nos
deux outils sont purs et instantanés, il n'y a aucune raison de les
sérialiser. Dans le test de la Leçon 8, le modèle a demandé `calculate` et
`get_current_datetime` dans le même tour, et les deux lignes sont apparues
ensemble dans l'interface.

### Exécuter un appel et en informer le navigateur

```ts
async function executeToolCall(call, { tools, signal, sse, log }): Promise<ContentPart> {
  sse.send({ event: "tool_call", data: { name: call.name, input: call.input } });

  const startedAt = performance.now();
  const result = await tools.execute(call.name, call.input, { signal, timeoutMs: TOOL_TIMEOUT_MS });
  const durationMs = Math.round(performance.now() - startedAt);

  log.info({ tool: call.name, durationMs, ok: result.ok }, "outil exécuté");
  sse.send({ event: "tool_result", data: { name: call.name, ok: result.ok } });

  return { type: "tool_result", toolCallId: call.id, content: result.content, isError: !result.ok };
}
```

Trois destinataires, trois niveaux d'information :

| Destinataire | Reçoit | Ne reçoit pas |
| --- | --- | --- |
| Navigateur (`tool_call`) | nom, arguments | |
| Navigateur (`tool_result`) | nom, `ok` | le contenu du résultat |
| Log serveur | nom, durée, `ok` | arguments, contenu |
| Modèle (`tool_result`) | contenu complet, `isError` | |

Le navigateur voit les arguments parce que l'utilisateur a le droit de
savoir ce que l'assistant a calculé. Il ne voit pas le résultat brut :
c'est le modèle qui le lui présente, en langue naturelle. Le log ne voit ni
l'un ni l'autre, par la même règle qu'au cours précédent : jamais de
contenu dans les logs.

### Le plafond de tours

```ts
const MAX_TOOL_TURNS = 5;
```

Sans plafond, un modèle qui boucle (il appelle un outil, n'est pas satisfait,
rappelle, etc.) coûterait indéfiniment. Cinq tours couvrent largement nos
cas : la question à deux outils en a pris deux. Si le cinquième tour demande
encore des outils, `runConversation` rend `false` et la route envoie un
`error` avec un message spécifique, « trop d'appels d'outils sans
conclure ». Ce n'est pas une panne, donc le message est explicite plutôt que
générique, et le log est en `warn`, pas en `error`.

> **À retenir**
> Un tour = un appel au modèle. Texte → SSE immédiatement. Appels → exécution
> en parallèle, puis deux messages ajoutés à l'historique (assistant avec
> les appels, user avec les résultats). Pas d'appel = fin. Cinq tours
> maximum.

**Questions**
1. Pourquoi faut-il accumuler `text` dans une variable alors qu'on l'a déjà
   envoyé au navigateur ?
2. Si on oubliait de pousser le message assistant dans `history` et qu'on
   ne poussait que les résultats, que verrait le modèle au tour suivant ?

---

## Leçon 6 : le navigateur affiche sans mémoriser

### Deux types pour deux usages

```ts
export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ToolActivity = { name: string; input: unknown; ok?: boolean };

export type UiMessage = ChatMessage & { tools?: ToolActivity[] };
```

`ChatMessage` est ce que le serveur accepte : du texte. `UiMessage` est ce
que l'interface manipule : le même message, plus une liste d'activités
d'outils **pour l'affichage**. Le `ok?` optionnel encode trois états avec
un seul champ : indéfini (en cours), `true`, `false`.

### Le client API : trois callbacks

```ts
export interface StreamChatHandlers {
  onDelta: (text: string) => void;
  onToolCall: (name: string, input: unknown) => void;
  onToolResult: (name: string, ok: boolean) => void;
}
```

Le `switch` dans `streamChat` gagne deux `case`. Le parseur SSE, lui, n'a
pas changé d'une ligne : il ne connaît pas les types d'événements, il
découpe des blocs `event:` / `data:`. C'est la récompense d'avoir séparé
« découper le flux » de « interpréter les événements » au cours précédent.

### Le hook : mettre à jour la dernière bulle

```ts
await streamChat(toWireHistory(history), controller.signal, {
  onDelta: (text) =>
    setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, content: m.content + text }))),
  onToolCall: (name, input) =>
    setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, tools: [...(m.tools ?? []), { name, input }] }))),
  onToolResult: (name, ok) =>
    setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, tools: markToolResult(m.tools, name, ok) }))),
});
```

Les trois callbacks ont la même forme : `setMessages` fonctionnel (toujours,
depuis un rappel asynchrone), et une seule fonction `updateLastAssistant`
qui applique une transformation à la dernière bulle si c'est bien une
bulle assistant. Le texte s'ajoute au `content`, l'appel s'ajoute à
`tools`, le résultat marque un élément de `tools`.

`markToolResult` cherche « le premier appel de ce nom encore en cours » :

```ts
const index = tools.findIndex((tool) => tool.name === name && tool.ok === undefined);
```

Pourquoi ce critère ? Parce que l'événement `tool_result` ne porte que le
nom, pas d'identifiant. Si le modèle appelle `calculate` deux fois dans le
même tour, les deux `tool_result` arrivent dans l'ordre d'achèvement, et on
marque les lignes dans l'ordre. C'est une approximation suffisante pour un
affichage ; si on voulait une correspondance exacte, il faudrait faire
transiter l'`id` dans les événements SSE.

### La projection en texte seul

```ts
/**
 * SIMPLIFICATION VOULUE : les appels d'outils et leurs résultats ne vivent que
 * le temps d'une requête, côté serveur. Au message suivant, le modèle ne voit
 * que sa réponse textuelle finale, pas les résultats bruts des outils. Pour
 * une question de suivi (« et en secondes ? »), il rappellera l'outil.
 */
function toWireHistory(messages: UiMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}
```

C'est le point que l'énoncé demandait de signaler dans le code. Les
activités d'outils ne quittent jamais le navigateur ; au message suivant,
le serveur reçoit un historique en texte pur, comme avant. Conséquence
observée pendant le test : à la question de suivi « et ce résultat en
secondes ? », le modèle a **rappelé** `get_current_datetime` plutôt que de
réutiliser la date du tour précédent, parce que de son point de vue cette
date n'était plus qu'une phrase dans sa propre réponse. C'est le prix de la
simplicité : pas de format riche à valider côté serveur, pas de risque
qu'un client forge de faux résultats d'outils, un historique qui reste
petit.

### L'affichage

```tsx
export function ToolActivityLine({ activity }: ToolActivityLineProps) {
  const state = activity.ok === undefined ? "pending" : activity.ok ? "ok" : "failed";
  const label = { pending: "en cours", ok: "succès", failed: "échec" }[state];
  return (
    <div className={`tool-activity tool-activity--${state}`}>
      <span className="tool-activity__icon" aria-hidden="true" />
      <code className="tool-activity__name">{activity.name}</code>
      <code className="tool-activity__input">{formatInput(activity.input)}</code>
      <span className="tool-activity__state">{label}</span>
    </div>
  );
}
```

Une ligne grise au-dessus du Markdown, un point coloré (clignotant en
cours, vert, rouge), le nom, les arguments en JSON tronqué à 120
caractères, l'état. Pas de bibliothèque, quelques règles CSS. `MessageBubble`
affiche ces lignes seulement s'il y en a, puis le Markdown comme avant.

> **À retenir**
> Le navigateur reçoit les appels en événements, les affiche dans la bulle
> en cours, et les oublie à l'envoi suivant. L'historique envoyé reste du
> texte : simplification assumée et documentée.

**Questions**
1. Quel est l'avantage de sécurité de ne jamais accepter de `tool_result`
   venant du client ?
2. Pourquoi `dropEmptyTrailingAssistant` vérifie-t-il maintenant aussi
   `!last.tools?.length` ?

---

## Leçon 7 : quand ça se passe mal

Reprenons chaque cas, du plus bénin au plus sérieux.

**L'expression est invalide.** `calculate` lève, le registre rend
`{ ok: false, content: "Expression invalide à la position 5 : nombre
attendu." }`. Le navigateur affiche la ligne en rouge, « échec ». Le modèle
reçoit le message, l'explique à l'utilisateur et propose des corrections.
La requête se termine par `done`. **Aucune erreur** du point de vue de
l'application : c'est le scénario nominal d'un mauvais argument.

**Le fuseau est inconnu.** Même chemin, message « Fuseau horaire inconnu ».

**Les arguments ne respectent pas le schéma.** Même chemin, mais sans que
l'outil ait été exécuté : Zod a refusé avant. Le modèle corrige en général au
tour suivant.

**L'outil est trop lent.** `AbortSignal.timeout` se déclenche, l'outil est
abandonné, le modèle reçoit « a dépassé le délai de 5000 ms ». Toujours pas
d'erreur de requête.

**Le modèle boucle.** Cinq tours de suite avec des appels d'outils. La route
envoie `error` avec un message explicite. Le navigateur affiche le bandeau
et Réessayer. Les deltas déjà reçus restent affichés.

**L'utilisateur clique Stop pendant un outil.** Le `fetch` est annulé, la
connexion fermée, `reply.raw` émet `close`, le contrôleur serveur s'arme.
Si un appel au modèle est en cours, le SDK le coupe. Si un outil est en
cours, son signal combiné se déclenche, le registre voit `signal.aborted`
et relance l'exception, la boucle s'interrompt, la route logue « client
déconnecté, génération annulée ». Côté navigateur, la bulle garde ce
qu'elle avait : texte partiel et lignes d'outils, la dernière restant « en
cours » puisque son résultat n'arrivera jamais.

**Le serveur plante vraiment.** Clé invalide, API Anthropic injoignable :
le chemin du cours précédent, `error` générique, log `error` avec la cause.

Remarquez la hiérarchie. Les quatre premiers cas sont **absorbés** par le
registre et renvoyés au modèle comme information. Les deux suivants sont
**des fins de requête** décidées par nous ou par l'utilisateur. Seul le
dernier est une **panne**. Les traiter au même niveau aurait rendu
l'interface inutilisable au premier calcul mal tapé.

> **À retenir**
> Un échec d'outil est une donnée pour le modèle, pas une erreur de requête.
> Seuls le plafond de tours et une vraie panne produisent un événement
> `error`. Stop coupe le modèle et l'outil en cours par le même signal.

**Questions**
1. Après un Stop pendant un outil, la ligne reste « en cours » pour
   toujours. Est-ce un bug ? Que faudrait-il pour la marquer autrement ?
2. Pourquoi le plafond de tours produit-il un message spécifique alors que
   la panne produit un message générique ?

---

## Leçon 8 : synthèse

### Le voyage complet de « Quel jour serons-nous dans 45 jours ? »

| # | Où | Quoi | Fichier |
| --- | --- | --- | --- |
| 1 | navigateur | `send` ajoute le message, projette l'historique en texte, `fetch` POST | `useChat.ts` |
| 2 | serveur | Zod valide, `hijack`, flux SSE ouvert | `routes/chat.ts` |
| 3 | serveur | tour 1 : `streamChat` avec l'historique et les deux définitions d'outils | `routes/chat.ts` |
| 4 | llm | le SDK reçoit `content_block_start` tool_use, accumule le JSON, `stop` → événement `tool_call` | `anthropic.ts` |
| 5 | serveur | SSE `tool_call { name: "get_current_datetime", input: { timezone: "Europe/Paris" } }` | `routes/chat.ts` |
| 6 | navigateur | une ligne « en cours » apparaît dans la bulle | `useChat.ts`, `ToolActivityLine.tsx` |
| 7 | serveur | registre : Zod OK, exécution, `{ ok: true, content: "{…iso…weekday…}" }` | `registry.ts`, `datetime.ts` |
| 8 | serveur | log `{ tool, durationMs, ok }`, SSE `tool_result { ok: true }` | `routes/chat.ts` |
| 9 | navigateur | la ligne passe en vert | `useChat.ts` |
| 10 | serveur | historique += assistant (tool_call) + user (tool_result) ; tour 2 | `routes/chat.ts` |
| 11 | llm | texte « jeudi 26 novembre 2026 » en `text_delta` | `anthropic.ts` |
| 12 | serveur | SSE `delta` × n, aucun `tool_call` → `done` | `routes/chat.ts` |
| 13 | navigateur | Markdown rendu, statut `idle` ; au prochain envoi, les lignes d'outils ne partent pas | `useChat.ts` |

### Les six idées à emporter

1. **Le modèle demande, le serveur exécute.** Le modèle n'a jamais accès à
   autre chose qu'une liste de descriptions.
2. **Un format neutre, un traducteur.** `ContentPart` et `LlmEvent` sont à
   nous ; `anthropic.ts` reste le seul fichier qui connaît `tool_use` et
   `tool_result`.
3. **Reconstituer en streaming.** Un appel d'outil arrive en morceaux
   indexés ; un tampon par index, émission au `stop`.
4. **Un échec d'outil est un résultat.** Le registre ne lève jamais, sauf
   déconnexion. Le modèle explique l'erreur mieux qu'un bandeau.
5. **La boucle a un plafond.** Cinq tours, puis un `error` explicite.
6. **Le client ne porte que du texte.** Les outils vivent le temps d'une
   requête ; c'est documenté dans le code, avec sa conséquence.

### Vérifications manuelles

Lance `npm run dev`, ouvre `http://localhost:5173`, et pour chaque cas
compare avec ce que tu dois voir.

| Message | Interface | Flux SSE (`curl -N`) | Log API |
| --- | --- | --- | --- |
| « Quel jour serons-nous dans 45 jours ? » | une ligne `get_current_datetime` verte, puis une date en texte | `tool_call`, `tool_result ok:true`, deltas, `done` | `appels d'outils demandés` turn 1, `outil exécuté` tool get_current_datetime |
| « Combien font 1234 × 5678 ? » | une ligne `calculate {"expression":"1234 * 5678"}` verte, puis « 7 006 652 » | idem avec `calculate` | idem |
| « Bonjour » | aucune ligne d'outil, réponse directe | deltas puis `done`, aucun `tool_call` | aucune ligne outil |
| « Calcule avec l'outil, sans la corriger, exactement : 12 ++* 7 » | une ligne `calculate` **rouge** « échec », puis une explication de l'erreur | `tool_result ok:false`, deltas, `done` | `outil exécuté` avec `ok:false` |
| « Quelle heure est-il à Mars/Olympus ? » | ligne rouge, le modèle explique que le fuseau est inconnu | idem | idem |
| Stop pendant une génération longue | la bulle garde texte et lignes, la dernière reste « en cours » | la connexion se ferme | `client déconnecté, génération annulée` |

Commandes utiles :

```bash
# Le flux brut, événement par événement
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Combien font 1234 * 5678 ?"}]}'

# Simuler une déconnexion au bout de 1,5 s pendant la boucle
curl -N --max-time 1.5 -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Quel jour serons-nous dans 45 jours ? Détaille."}]}'

# Vérifier qu'aucun argument ni résultat ne fuit dans les logs
# (lance l'API avec la sortie redirigée, puis cherche)
grep -c "5678\|Europe/Paris" api.log     # doit afficher 0
```

### Pour aller plus loin (non fait, volontairement)

- **Faire transiter l'`id`** des appels dans les événements SSE pour une
  correspondance exacte entre `tool_call` et `tool_result` côté navigateur.
- **Garder les résultats d'outils dans l'historique client**, avec un
  format riche validé côté serveur. Il faudrait alors décider ce qu'un
  client a le droit d'affirmer, et empêcher les faux résultats.
- **Des outils à effet de bord** (envoyer un mail, écrire un fichier). Ils
  demandent une confirmation de l'utilisateur avant exécution, ce qui
  change la boucle : il faut pouvoir la suspendre.
- **Des outils venus d'ailleurs** (MCP). Le registre est prêt : il suffit
  d'adapter chaque outil distant à l'interface `Tool`.

---

## Corrigé des questions

> Essaie d'abord, compare ensuite.

### Leçon 0

**1. Pourquoi un outil pour la date ?** Un modèle de langage est figé à la
fin de son entraînement et ne possède aucune horloge. Quand il « donne »
une date, il la devine à partir d'indices du texte ou de sa date
d'entraînement, souvent faux de plusieurs mois. Tout ce qui est *actuel*
(date, météo, cours, état d'une base) doit lui être fourni de l'extérieur.
Le tool use est le mécanisme standard pour cela.

**2. Qu'est-ce qui empêche un utilisateur de faire exécuter n'importe quoi ?**
Trois barrières. Le modèle ne peut demander que les outils que *nous*
déclarons, par leur nom : il n'existe pas d'outil « exécute une commande ».
Chaque outil valide ses arguments avec un schéma Zod avant de s'exécuter.
Et nos outils sont écrits pour ne rien faire de dangereux : `calculate`
n'interprète qu'une grammaire arithmétique, pas du JavaScript. La surface
d'attaque est exactement ce que fait le code de l'outil, pas plus.

### Leçon 1

**1. Pourquoi un `id` ?** Parce que le modèle peut appeler **le même outil
plusieurs fois dans le même tour**, avec des arguments différents (deux
calculs, deux fuseaux). Le nom ne suffit plus à apparier chaque résultat à
sa demande. L'`id` est généré par le modèle, et le fournisseur exige qu'on
le renvoie dans le `tool_result`. Sans lui, l'API rejetterait le message.

**2. Si `input` était `Record<string, string>` ?** Le type mentirait. Le
modèle produit du JSON libre : nombres, booléens, objets imbriqués, ou rien
du tout. Le code qui lirait `input.expression` croirait avoir une `string`
alors que rien ne l'a vérifié, et planterait au premier appel inattendu.
`unknown` force à passer par une validation (le `safeParse` du registre)
avant toute lecture. C'est le typage honnête d'une donnée externe.

### Leçon 2

**1. Pourquoi indexer par `event.index` ?** Parce qu'une réponse peut
contenir plusieurs blocs, et rien n'oblige le fournisseur à terminer un
bloc avant d'en commencer un autre. Avec une seule variable « appel en
cours », deux appels d'outils dans la même réponse mélangeraient leurs
fragments JSON. Une `Map` par index garde chaque tampon séparé. Le coût est
nul et le code est correct dans tous les cas.

**2. `JSON.parse` à chaque delta ?** Chaque fragment est un **morceau** de
JSON, pas un JSON valide : `{"expr` n'est pas parsable. On aurait une
exception dès le premier delta. Il faut attendre `content_block_stop`,
qui garantit que le tampon contient un document complet. (Le SDK propose
une option, `eager_input_streaming`, pour des outils aux arguments très
longs ; nous ne l'avons pas activée, nos arguments tiennent en quelques
octets.)

### Leçon 3

**1. D'où vient `"Europe/Paris"` ?** De trois indices combinés : la
description du champ dit « Fuseau horaire IANA, par exemple
"Europe/Paris" », l'utilisateur écrit en français, et le prompt système
demande de répondre dans la langue de l'utilisateur. Le modèle en déduit
le fuseau le plus probable. C'est utile, mais ce n'est qu'une
**inférence** : pour un utilisateur à Montréal écrivant en français, elle
serait fausse. Une vraie application transmettrait le fuseau du navigateur
dans la requête.

**2. Pourquoi `-3 ^ 2 = -9` ?** Parce qu'en mathématiques (et dans
Python, Excel ou une calculatrice), l'exponentiation est **prioritaire sur le
moins unaire** : `-3²` se lit « l'opposé de 3² ». La décision est prise dans
l'ordre des règles de la grammaire : `unaire` appelle `puissance`, donc le
`-` s'applique au résultat de la puissance. Si on avait écrit
`puissance := unaire ("^" …)`, le `-` aurait été absorbé avant le `^` et
on aurait obtenu 9. Pour obtenir 9, l'utilisateur écrit `(-3) ^ 2`.

### Leçon 4

**1. Pourquoi la déconnexion relance-t-elle ?** Parce qu'elle n'a pas le
même **destinataire**. Un échec d'outil est une information pour le modèle,
donc on la transforme en résultat et on continue la boucle. Une
déconnexion signifie qu'il n'y a plus personne à qui répondre : continuer
la boucle appellerait le modèle pour rien, en payant des tokens. On
relance pour interrompre toute la requête, et la route reconnaît ce cas
avec `signal.aborted`, comme au cours précédent.

**2. Que gagne-t-on avec `z.toJSONSchema` ?** Une **source de vérité
unique**. Si le schéma JSON était écrit à la main à côté du schéma Zod,
ils finiraient par diverger : un champ renommé d'un côté, pas de l'autre.
Le modèle produirait alors des arguments que Zod refuse, et on aurait
un bug subtil. Générer l'un depuis l'autre rend cette divergence
impossible, et les `.describe()` servent aux deux usages.

### Leçon 5

**1. Pourquoi accumuler `text` ?** Parce que si le tour demande des outils,
il faut **renvoyer au modèle son propre message** tel quel au tour suivant,
texte compris. Le fournisseur exige que l'historique contienne le message
assistant qui a produit les `tool_use`. Le texte accumulé devient le bloc
`text` de ce message. Le navigateur l'a déjà reçu, mais le modèle, lui, a
besoin de le relire.

**2. Sans le message assistant dans `history` ?** L'API refuserait la
requête : un `tool_result` doit répondre à un `tool_use` présent dans le
message précédent, avec le même id. Et même si elle l'acceptait, le modèle
verrait des résultats d'outils sans savoir quelle question il avait posée,
donc sans pouvoir les interpréter. Les deux messages vont ensemble.

### Leçon 6

**1. Avantage de sécurité ?** Un client qui pourrait envoyer des
`tool_result` pourrait **inventer des résultats** : « l'outil
`get_balance` a répondu 1 000 000 € », et le modèle le croirait, puisque
pour lui un résultat d'outil est une vérité venue du serveur. En
n'acceptant que du texte, le serveur garantit que tout `tool_result` de
l'historique a été produit par lui, dans cette requête. C'est la même
raison pour laquelle le prompt système n'est jamais fourni par le client.

**2. Pourquoi `!last.tools?.length` ?** Parce qu'une bulle peut avoir des
lignes d'outils **sans encore avoir de texte** : le modèle a appelé un
outil, puis l'utilisateur a cliqué Stop avant le premier delta. Avec
l'ancien critère (`content === ""`), cette bulle aurait été supprimée, et
l'utilisateur aurait perdu l'information « un outil a été appelé ». Une
bulle est vide seulement si elle n'a ni texte ni activité.

### Leçon 7

**1. La ligne « en cours » après Stop, est-ce un bug ?** C'est un choix
cohérent mais imparfait. Le navigateur ne reçoit jamais de `tool_result`
pour cet appel, donc `ok` reste indéfini. Pour afficher « interrompu », il
faudrait, dans le `catch` de `run`, parcourir les activités de la dernière
bulle et marquer celles dont `ok` est indéfini avec un quatrième état. Une
dizaine de lignes, laissées comme exercice.

**2. Pourquoi un message spécifique pour le plafond ?** Parce que la règle
du message générique protège contre les **fuites d'informations
techniques** (URL, identifiants, messages du SDK). Le plafond de tours
n'est pas une information technique : c'est une limite que nous avons
choisie, et l'utilisateur peut agir dessus en reformulant. Dire « trop
d'appels d'outils » l'aide ; dire « la génération a échoué » le laisserait
réessayer la même question en boucle.
