# Approfondissement · Jour 1 · Cours 1 — Le code du flux d'un message

> [← Retour au cours](../jour-1-flux-dun-message.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/src/config.ts` | Lit `apps/api/.env`, vérifie les variables obligatoires | 1 |
| `apps/web/vite.config.ts` | Relaie `/api/*` vers Fastify en développement | 1 |
| `apps/api/src/llm/types.ts` | Format neutre et interface `LlmClient` | 2 |
| `apps/api/src/llm/factory.ts`, `llm/index.ts` | Choix de la classe, point d'entrée public | 2 |
| `apps/api/src/llm/anthropic.ts` | Seule implémentation, seul fichier qui importe le SDK | 2 |
| `apps/api/src/hello.ts` | Le premier maillon du streaming, seul, dans le terminal | 3 |
| `apps/api/src/sse.ts` | Format SSE et ouverture du flux sur la réponse brute | 3 |
| `apps/api/src/server.ts` | Démarrage : configuration, client LLM, routes sous `/api` | 4 |
| `apps/api/src/routes/chat.ts` | `POST /api/chat` : valider, ouvrir le flux, relayer, fermer | 4 |
| `apps/web/src/chat/api.ts` | `fetch`, lecture du corps, aiguillage des événements | 5 |
| `apps/web/src/chat/sse.ts` | Parseur SSE incrémental | 5 |
| `apps/web/src/chat/useChat.ts` | Tout l'état du chat : messages, statut, Stop, Réessayer | 5, 7 |
| `apps/web/src/chat/Chat.tsx` | Assemble le hook et les composants | 6 |
| `apps/web/src/chat/Composer.tsx` | Saisie, Entrée / Maj+Entrée, bouton Stop | 6 |
| `apps/web/src/chat/MessageList.tsx` | Liste des bulles, défilement automatique | 6 |
| `apps/web/src/chat/MessageBubble.tsx` | Texte brut ou Markdown, curseur | 6 |
| `apps/web/src/chat/ErrorBanner.tsx` | Bandeau d'erreur et bouton Réessayer | 7 |

## Le parcours dans le code

Le message « Explique les monorepos », de la touche Entrée au rendu :

1. `Composer.tsx` · `handleKeyDown` → `submit()` → `onSend(draft)` (le `send`
   de `useChat`).
2. `useChat.ts` · `send` → `run(...)`, qui ajoute une bulle assistant vide,
   passe en `"streaming"` et appelle `streamChat(toWireHistory(history), ...)`.
3. `api.ts` · `fetch("/api/chat", { method: "POST" })`, relayé par le proxy
   de `vite.config.ts` vers Fastify, qui confie la route à `chatRoutes`
   (`server.ts`).
4. `routes/chat.ts` · `safeParse` → `AbortController` + `close` →
   `reply.hijack()` → `openSseStream(reply.raw)` → `runConversation`.
5. `llm/anthropic.ts` · `streamChat` `yield` un `{ type: "text" }` par
   `text_delta` du SDK.
6. `routes/chat.ts` · chaque fragment → `sse.send({ event: "delta" })` →
   `res.write` (`sse.ts`). À la fin : `done`, puis `sse.close()`.
7. `api.ts` · `reader.read()` → `TextDecoder` → `parser.push()`
   (`chat/sse.ts`) → `handlers.onDelta(text)`.
8. `useChat.ts` · `setMessages(prev => updateLastAssistant(...))`.
9. `MessageList.tsx` → `MessageBubble.tsx` re-rend la dernière bulle en
   Markdown, avec le curseur ; l'effet de défilement suit.

## `apps/api/src/config.ts`

Rôle : charger le `.env` de l'API et refuser de démarrer sans les variables.

### `loadConfig()`

```ts
export function loadConfig(): Config {
  loadDotEnv();
  requireEnv(REQUIRED_VARS);

  return {
    port: Number(process.env["PORT"] ?? 3000),
    llm: {
      provider: process.env["LLM_PROVIDER"]!.trim(),
      apiKey: process.env["LLM_API_KEY"]!.trim(),
      model: process.env["LLM_MODEL"]!.trim(),
    },
  };
}
```

**Ce que fait le code**, dans l'ordre :
1. `loadDotEnv()` appelle `loadEnvFile`, fourni par Node (`node:process`,
   sans `dotenv`), sur `ENV_FILE`, calculé par
   `new URL("../.env", import.meta.url)` à partir de `src/config.ts`. Si le
   fichier manque (`error.code === "ENOENT"`, testé par `isFileNotFound`),
   l'erreur est avalée ; toute autre erreur remonte.
2. `requireEnv(REQUIRED_VARS)` garde les noms dont
   `process.env[name]?.trim()` est vide ou `undefined` et, s'il en reste,
   lève une `ConfigError` sur trois lignes : variables manquantes, quoi faire
   (copier `.env.example`), chemin attendu.
3. L'objet `Config` est construit : `PORT` vaut 3000 par défaut, chaque
   valeur est rognée. Le `!` affirme à TypeScript que la valeur existe, ce
   que `requireEnv` vient de garantir.

**Pourquoi c'est écrit ainsi** :
- Partir de `import.meta.url` et non du répertoire courant fait trouver le
  `.env` qu'on lance depuis la racine (`npm run dev`) ou depuis `apps/api`.
- `ConfigError` est une classe dédiée : `server.ts` et `hello.ts` affichent
  son message tel quel et laissent remonter les autres erreurs.

## `apps/web/vite.config.ts`

Rôle : servir le front sur le port 5173 et relayer `/api` vers Fastify.

```ts
  server: {
    port: 5173,
// …
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
```

**Ce que fait le code** : toute requête vers `http://localhost:5173/api/...`
est retransmise par le serveur de développement de Vite à
`http://127.0.0.1:3000/api/...`, et la réponse revient morceau par morceau.
Pour le navigateur, l'API est sur la même origine que la page : pas de CORS,
et le front écrit simplement `fetch("/api/chat")`.

## `apps/api/src/llm/types.ts`, `factory.ts` et `index.ts`

Rôle : notre propre vocabulaire, indépendant du fournisseur, et le choix de
l'implémentation.

```ts
export interface LlmClient {
  /** Renvoie la réponse sous forme d'événements (texte, appels d'outils), au fil de l'eau. */
  streamChat(params: StreamChatParams): AsyncIterable<LlmEvent>;
}
```

```ts
export function createLlmClient({ provider, apiKey, model }: LlmClientOptions): LlmClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicLlmClient(apiKey, model);
    default:
      throw new Error(
        `Fournisseur LLM inconnu : "${provider}". Valeurs possibles : ${KNOWN_PROVIDERS.join(", ")}.`,
      );
  }
}
```

**Ce que fait le code** :
1. `ChatMessage` : un rôle et un contenu (ici, une chaîne).
   `StreamChatParams` : `system`, `messages`, `signal` (plus `tools`, `effort`).
2. `LlmEvent` est une union discriminée sur `type` : après
   `if (event.type === "text")`, TypeScript sait que `event.text` existe.
   `streamChat` en renvoie un `AsyncIterable`, consommé par `for await`.
3. `createLlmClient` renvoie un `AnthropicLlmClient` pour `"anthropic"`,
   sinon une erreur qui liste les valeurs possibles. Son type de retour est
   `LlmClient`, et `llm/index.ts` n'exporte pas la classe.

*`LlmEvent` (le cours montre encore des `string`) est arrivé avec les
outils : voir [l'approfondissement du tool use](jour-1-appel-doutils.md).*

**Pourquoi c'est écrit ainsi** : aucun type du SDK ne sort de `llm/` ; un
nouveau fournisseur, c'est un fichier et un `case`.

## `apps/api/src/llm/anthropic.ts`

Rôle : traduire notre format vers le SDK, et le flux du SDK vers nos
`LlmEvent`.

### `streamChat()`

```ts
  async *streamChat({ system, messages, tools, signal, effort }: StreamChatParams): AsyncIterable<LlmEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: messages.map(toAnthropicMessage),
// …
        ...(effort && { output_config: { effort } }),
      },
      { signal },
    );
// …
    for await (const event of stream) {
      switch (event.type) {
// …
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
// …
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === "refusal") {
      throw new Error("Le modèle a refusé de répondre à cette requête.");
    }
  }
```

**Ce que fait le code** :
1. `async *` fait de `streamChat` une génératrice asynchrone : l'appeler ne
   lance rien, le code démarre au premier `for await` de l'appelant.
2. `messages.stream(...)` prépare la requête (modèle, plafond de 16 000
   tokens, prompt système, messages traduits par `toAnthropicMessage`).
   `...(effort && {...})` n'ajoute `output_config` que si `effort` est
   défini ; `{ signal }` laisse le SDK couper la requête HTTP.
3. Chaque `content_block_delta` de type `text_delta` est `yield` aussitôt ;
   la génératrice se suspend là jusqu'à ce que l'appelant demande la suite.
4. Flux épuisé : `finalMessage()` donne le message complet assemblé par le
   SDK ; un `stop_reason` égal à `"refusal"` devient une erreur, que la route
   traite comme tout autre échec.

*Les autres cas reconstituent les appels d'outils : voir
[l'approfondissement du tool use](jour-1-appel-doutils.md).*

**Pourquoi c'est écrit ainsi** :
- Le `yield` immédiat préserve le streaming : rien n'est accumulé ici.
- Le refus n'est connu qu'à la fin ; le vérifier après la boucle évite
  d'envoyer `done` pour une réponse refusée.

## `apps/api/src/hello.ts`

Rôle : `npm run hello` écrit la réponse du modèle dans le terminal.

```ts
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
// …
  for await (const event of llm.streamChat({
    messages: [{ role: "user", content: QUESTION }],
    signal: controller.signal,
  })) {
    if (event.type === "text") process.stdout.write(event.text);
  }
```

**Ce que fait le code** : après `loadConfig()` et `createLlmClient()`, il
relie Ctrl+C (`SIGINT`) à `abort()`, puis écrit chaque fragment avec
`process.stdout.write`, sans retour à la ligne. Le `catch` sort avec le code 1.

## `apps/api/src/sse.ts`

Rôle : connaître le format SSE et écrire sur la réponse HTTP brute de Node.

`SseEvent` associe chaque nom d'événement à la forme de son `data` : ici
`delta` (`{ text }`), `done` (objet vide) et `error` (`{ message }`).
*`sources` : jour 2 ([jour-2-recherche-reponse.md](jour-2-recherche-reponse.md)) ;
`tool_call`, `tool_result` : [jour-1-appel-doutils.md](jour-1-appel-doutils.md) ;
`debug` alimente le journal d'événements.*

### `openSseStream()`

```ts
export function openSseStream(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
// …
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const isWritable = () => !res.destroyed && !res.writableEnded;

  return {
    send(event: SseEvent): void {
      if (isWritable()) res.write(formatSseEvent(event));
    },
    close(): void {
      if (isWritable()) res.end();
    },
  };
}
```

**Ce que fait le code** :
1. `formatSseEvent`, défini juste avant dans le fichier, renvoie
   `` `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` ``. Un saut de
   ligne du modèle devient `\n` littéral (deux caractères) dans le JSON : il
   ne peut pas couper l'événement.
2. `writeHead(200, ...)` fixe statut et en-têtes (dont `Cache-Control:
   no-cache, no-transform`, coupé ici), qui ne pourront plus changer ; `flushHeaders()` les envoie tout de suite, et le `fetch` du
   navigateur se résout sans attendre le premier fragment.
3. `isWritable` vérifie que la connexion n'est ni détruite (client parti) ni
   déjà terminée ; `send` et `close` ne font rien sinon.

**Pourquoi c'est écrit ainsi** : la route ignore le format et les en-têtes ;
`send` est typé par `SseEvent`, et la garde lui permet d'appeler `close()`
dans son `finally` sans se demander si le client est encore là.

## `apps/api/src/server.ts`

Rôle : point d'entrée de l'API (`tsx watch src/server.ts`).

```ts
await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    await api.register(chatRoutes, { llm, tools, retrieve });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });
```

**Ce que fait le code** :
1. Avant l'extrait : `loadConfigOrExit()` affiche une `ConfigError` préfixée
   de `[config]` puis fait `process.exit(1)` ; `createLlmClient` construit
   **un seul** client ; `Fastify({ logger: true })` trace méthode, URL et
   statut, jamais le corps.
2. `register(..., { prefix: "/api" })` regroupe `/api/health` et, via le
   plugin `chatRoutes` qui reçoit ses dépendances, `/api/chat`.
3. `listen` écoute sur `127.0.0.1`, donc en local seulement.

**Pourquoi c'est écrit ainsi** : les dépendances sont créées au démarrage et
**injectées** ; la route ne lit jamais `process.env`. *`tools` et
`retrieve` servent aux outils et à la recherche, ajoutés plus tard.*

## `apps/api/src/routes/chat.ts`

Rôle : le gestionnaire de `POST /api/chat`.

### Le schéma Zod

```ts
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Le contenu est vide.").max(MAX_CONTENT_LENGTH),
});
// …
  messages: z
    .array(chatMessageSchema)
    .min(1, "Il faut au moins un message.")
    .max(MAX_MESSAGES, `Au plus ${MAX_MESSAGES} messages par requête.`)
    .refine((messages) => messages.at(-1)?.role === "user", {
      message: 'Le dernier message doit avoir le rôle "user".',
    }),
```

**Ce que fait le code** :
1. `role` est limité à `user` et `assistant` : un rôle `system` est refusé.
2. `content` est une chaîne **rognée** (`trim()` transforme la valeur), de
   1 à 8 000 caractères ; le texte passé à `.min` finira dans le bandeau.
3. `messages` contient de 1 à 50 éléments ; `.refine` ajoute une règle libre :
   le dernier vient de l'utilisateur. (Le champ `debug`, coupé ici, sert au
   journal d'événements.)

### Valider, préparer l'annulation, prendre la main

```ts
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Réponse JSON classique : le flux SSE n'est pas encore ouvert.
      return reply.code(400).send({
        error: "Corps de requête invalide.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    // Si le client ferme la connexion, on annule l'appel au modèle et les outils en cours.
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());

    // On prend la main sur la réponse brute : Fastify ne la sérialisera pas.
    reply.hijack();
    const sse = openSseStream(reply.raw);
```

**Ce que fait le code** :
1. `safeParse` ne lève pas : il renvoie `{ success: true, data }` ou
   `{ success: false, error }`.
2. Échec : un **400 en JSON**, chaque problème réduit à un chemin
   (`messages.0.content`) et un message ; le `return` termine le gestionnaire.
3. Un `AbortController` par requête. `reply.raw` est la `ServerResponse` de
   Node ; son événement `close` (connexion fermée) déclenche `abort()`, une
   seule fois grâce à `once`.
4. `reply.hijack()` dit à Fastify de ne plus toucher à la réponse ;
   `openSseStream` envoie le 200 et les en-têtes SSE.

**Pourquoi c'est écrit ainsi** : tout autre statut que 200 doit se décider
**avant** `openSseStream`, qui l'envoie. Et sans `hijack()`, Fastify
tenterait d'envoyer sa propre réponse sur une réponse déjà commencée.

### Relayer le modèle

Le `try` appelle `runConversation(...)` avec `controller.signal` et `sse`,
puis envoie `event: done` si elle renvoie `true`. *Ajouté au jour 2 avant
cet appel (recherche, `sources`, prompt RAG) : voir
[l'approfondissement de la réponse sourcée](jour-2-recherche-reponse.md).*
Le relais, dans `runConversation` :

```ts
    const stream = llm.streamChat({ ...params, signal });
    for await (const event of stream) {
      if (event.type === "text") {
        text += event.text;
        sse.send({ event: "delta", data: { text: event.text } });
      } else {
        toolCalls.push(event);
      }
    }
```

**Ce que fait le code** : `llm.streamChat` reçoit le prompt système,
l'historique et le `signal` ; chaque fragment de texte part **aussitôt** en
`event: delta` (la copie dans `text` ne sert qu'aux outils et au débogage).
Sans appel d'outil, `runConversation` renvoie `true`. *La boucle d'outils
(`MAX_TOOL_TURNS`, `executeToolCall`) : voir
[jour-1-appel-doutils.md](jour-1-appel-doutils.md).*

### Le `catch`, le `finally` et `describeError()`

```ts
    } catch (error) {
      if (controller.signal.aborted) {
        request.log.info("client déconnecté, génération annulée");
      } else if (error instanceof RetrievalError) {
// …
      } else {
        // Seul le message d'erreur technique est logué, jamais le contenu des messages.
        request.log.error({ reason: describeError(error) }, "échec de la génération");
        sse.send({ event: "error", data: { message: GENERIC_ERROR_MESSAGE } });
      }
    } finally {
      sse.close();
    }
```

```ts
function describeError(error: unknown): string {
  // Une connexion refusée en IPv6 puis en IPv4 arrive sous forme d'AggregateError,
  // au message vide : on décrit plutôt chacune des erreurs regroupées.
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join(" ; ");
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
```

**Ce que fait le code** :
1. Signal déclenché : l'erreur vient de l'annulation ; une ligne `info`
   suffit, le client est parti.
2. Sinon, la cause va dans le log, et le client reçoit `event: error` avec
   « La génération a échoué. Réessaie dans un instant. ». *La branche
   `RetrievalError` est ajoutée au jour 2.*
3. Le `finally` ferme le flux dans tous les cas.
4. `describeError` décrit une `AggregateError` erreur par erreur
   (récursivement), une `Error` en `Nom: message`, le reste par `String`.

**Pourquoi c'est écrit ainsi** : on logue une **raison**, jamais le contenu
des messages ; le client reçoit un message générique, car la vraie cause
peut révéler des détails internes.

## `apps/web/src/chat/api.ts`

Rôle : envoyer l'historique, lire le flux, appeler un handler par
événement. `ChatError` marque un message affichable tel quel.

### `streamChat()`

```ts
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;

      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        handlers.onEvent?.(event.event, event.data);
        switch (event.event) {
          case "delta":
            handlers.onDelta(parseJson<{ text: string }>(event.data).text);
            break;
// …
          case "done":
            completed = true;
            break;
          case "error":
            throw new ChatError(parseJson<{ message: string }>(event.data).message);
        }
      }
    }
  } finally {
    // Libère la connexion si on sort avant la fin (erreur, abort).
    await reader.cancel().catch(() => undefined);
  }
```

**Ce que fait le code** :
1. Avant l'extrait, `fetch` envoie un `POST` avec l'historique en JSON et le
   `signal` de `useChat` ; il se résout **dès les en-têtes reçus**. Un
   statut non 2xx devient une `ChatError` (via `describeHttpError`), puis on
   crée le lecteur (`getReader()`), un `TextDecoder` et le parseur.
2. `reader.read()` renvoie le prochain morceau d'octets, ou `done: true`
   quand le serveur a fermé. `decode(value, { stream: true })` le convertit
   en texte en gardant de côté un caractère UTF-8 coupé.
3. `parser.push` renvoie zéro, un ou plusieurs événements complets :
   `delta` appelle `onDelta`, `done` met `completed` à `true` et arrête la
   boucle, `error` lève une `ChatError` avec le message du serveur.
   *`onEvent` alimente le journal ; `sources`, `tool_call`, `tool_result` et
   `debug` sont des cas ajoutés plus tard.*
4. Le `finally` libère la connexion. Après lui, une sortie sans `done` lève
   « La connexion s'est interrompue avant la fin de la réponse. ».

**Pourquoi c'est écrit ainsi** : `fetch` plutôt qu'`EventSource`, qui ne
fait que des `GET` sans corps. Et `describeHttpError` lit, pour un 400, le premier `issues[].message`
(« Requête refusée : … ») ; tout autre statut donne « Erreur du serveur
(HTTP …) », comme le 500 du proxy Vite quand l'API est arrêtée.

## `apps/web/src/chat/sse.ts`

Rôle : découper un texte reçu en morceaux arbitraires en événements complets.

```ts
export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
// …
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");

      const events: SseEvent[] = [];
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseBlock(block);
        if (event) events.push(event);
        separator = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}
```

**Ce que fait le code** :
1. `buffer` est capturé par la fermeture : il survit d'un `push` à l'autre.
   Le morceau y est ajouté, et les `\r\n` ramenés à `\n`.
2. Tant que le tampon contient `\n\n`, le bloc qui précède est découpé,
   retiré du tampon et passé à `parseBlock`. Ce qui reste est un événement
   incomplet, qui attend le morceau suivant.
3. `parseBlock` coupe chaque ligne au **premier** `:` (ce qui garde intact
   un JSON comme `{"text":"a:b"}`), ignore lignes vides et commentaires,
   retient `event` (par défaut `"message"`) et joint les lignes `data`. Le
   `JSON.parse` se fait dans `api.ts`.

## `apps/web/src/chat/useChat.ts`

Rôle : porter l'état (`messages`, `status`, `error`, et `abortRef`, un
`useRef` car changer de contrôleur ne doit pas provoquer de rendu) et
exposer `send`, `stop` et `retry`. *`log` et `append` alimentent le journal
d'événements, sans effet sur le flux.*

### `run()`

```ts
  const run = useCallback(async (history: UiMessage[]) => {
    const controller = new AbortController();
    abortRef.current = controller;

    // Bulle assistant vide, remplie au fil des deltas.
    setMessages([...history, { role: "assistant", content: "" }]);
    setStatus("streaming");
    setError(null);
// …
      await streamChat(wire, controller.signal, {
// …
        onDelta: (text) => setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, content: m.content + text }))),
// …
      });
      setStatus("idle");
// …
    } catch (err) {
      setMessages(dropEmptyTrailingAssistant);
      if (controller.signal.aborted) {
        // Arrêt volontaire : pas une erreur.
        setStatus("idle");
// …
      } else {
        const message = err instanceof Error ? err.message : "Erreur inconnue.";
        setError(message);
        setStatus("error");
// …
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [append]);
```

**Ce que fait le code** :
1. Un `AbortController` par requête, rangé dans `abortRef` pour `stop`.
   L'historique est affiché suivi d'une bulle assistant **vide**.
2. `await streamChat(...)` dure toute la réponse (`wire`, coupé ici, vaut
   `toWireHistory(history)`). Chaque `onDelta` allonge la dernière bulle
   avec la **forme fonctionnelle** `setMessages(prev => ...)`.
3. Rejet : `dropEmptyTrailingAssistant` retire une bulle assistant vide.
   Signal déclenché : c'est un Stop, `"idle"` sans erreur. Sinon, le message
   est stocké et le statut passe à `"error"`.
4. Le `finally` vide `abortRef`, s'il contient encore **ce** contrôleur.

**Pourquoi c'est écrit ainsi** :
- `run` est une fermeture créée avant la réponse : `messages` y garderait
  l'ancienne valeur, alors que `prev` est toujours l'état le plus récent.
- *`onSources`, `onToolCall`, `onToolResult` : voir
  [jour-1-appel-doutils.md](jour-1-appel-doutils.md) et
  [jour-2-recherche-reponse.md](jour-2-recherche-reponse.md) ; `onHttp`,
  `onEvent`, `onDebug` alimentent le journal.*

### `send`, `stop`, `retry` et `updateLastAssistant()`

```ts
function updateLastAssistant(
  messages: UiMessage[],
  update: (message: UiMessage) => UiMessage,
): UiMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), update(last)];
}
```

**Ce que fait le code** :
1. `send` rogne le texte, refuse un texte vide ou un envoi pendant une
   génération, puis fait `void run([...messages, { role: "user", content }])`
   (`void` : on n'attend pas la promesse, volontairement).
2. `stop` appelle `abortRef.current.abort()` : le `fetch` ou le
   `reader.read()` en attente rejette, et `run` passe dans son `catch`.
3. `retry` applique `trimToLastUserMessage`, qui retire les messages
   assistant de fin, et relance `run` sans rien retaper.
4. `toWireHistory` ne garde que `role` et `content` : `tools` et `sources`
   ne sont qu'un affichage et ne repartent jamais au serveur.
5. `updateLastAssistant` renvoie un **nouveau** tableau dont le dernier
   élément est remplacé par `update(last)`.

**Pourquoi c'est écrit ainsi** : React compare les références ; modifier le
tableau en place ne déclencherait aucun rendu. `send` et `retry` lisent
`messages` et `status`, d'où leurs dépendances ; `stop` ne lit qu'une
référence.

## `apps/web/src/chat/Chat.tsx`

Rôle : le seul composant qui appelle `useChat()` ; il distribue l'état.

```tsx
        <MessageList messages={messages} status={status} />

        {status === "error" && error && <ErrorBanner message={error} onRetry={retry} />}

        <Composer disabled={status === "streaming"} onSend={send} onStop={stop} />
```

**Ce que fait le code** : bandeau seulement en statut `"error"`, `Composer`
désactivé pendant la génération. *Le reste concerne le journal d'événements.*

## `apps/web/src/chat/Composer.tsx`

Rôle : la zone de saisie.

```tsx
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Entrée envoie, Maj+Entrée insère un saut de ligne.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
```

**Ce que fait le code** :
1. `draft`, un `useState` local, contient le texte en cours de frappe : le
   parent ne se re-rend pas à chaque touche.
2. `submit`, défini juste avant, refuse un envoi désactivé ou vide, appelle
   `onSend(draft)`, puis vide la zone.
3. Entrée sans Maj : `preventDefault()` empêche le saut de ligne, puis
   `submit()`. Avec Maj, rien n'est intercepté.
4. Dans le JSX, `disabled` choisit le bouton : Stop (`type="button"`) ou
   Envoyer (`type="submit"`, désactivé si `draft` est vide).

## `apps/web/src/chat/MessageList.tsx`

Rôle : afficher les bulles et suivre le bas de la conversation.

```tsx
  // Défile vers le bas à chaque changement de l'historique (nouveau message ou delta).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);
```

**Ce que fait le code** : à chaque changement de `messages`, donc à chaque
delta, l'effet fait défiler jusqu'au `<div ref={bottomRef} />` vide placé en
fin de liste. `streaming` n'est passé à vrai qu'à la dernière bulle.

**Pourquoi c'est écrit ainsi** : l'effet ne dépend que de la donnée
`messages`, jamais d'une fonction.

## `apps/web/src/chat/MessageBubble.tsx` et `ErrorBanner.tsx`

Rôle : texte brut pour l'utilisateur, Markdown pour l'assistant.

```tsx
      {isUser ? (
        // Le texte utilisateur est affiché tel quel, sauts de ligne compris.
        <p className="bubble__text">{message.content}</p>
      ) : (
        <>
// …
          <div className="bubble__markdown">
            {/* Pas de rehype-raw : le HTML éventuel reste du texte échappé. */}
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {markdown}
            </Markdown>
            {streaming && <span className="bubble__cursor" aria-hidden="true" />}
          </div>
```

**Ce que fait le code** :
1. Bulle utilisateur : le texte dans un `<p>` ; React l'échappe, un
   `<script>` tapé s'affiche tel quel.
2. Bulle assistant : `react-markdown` produit des éléments React, et
   `remark-gfm` ajoute tableaux, listes de tâches et texte barré. Sans
   `rehype-raw`, une balise HTML écrite par le modèle reste du texte.
3. Pendant le streaming, un `<span>` vide suit le Markdown ; dans
   `chat.css`, `.bubble__cursor` en fait un petit bloc coloré que
   l'animation `blink` fait clignoter.
4. `ErrorBanner` est sans état : le message dans un `<div role="alert">`
   et un bouton Réessayer qui appelle `retry`.

*`markdown` (passé par `linkifyCitations`), `components` et `SourceList`
viennent au jour 2 ([jour-2-recherche-reponse.md](jour-2-recherche-reponse.md)).*

**Pourquoi c'est écrit ainsi** : le Markdown est re-parsé à chaque delta ;
un `**` pas encore fermé s'affiche tel quel, puis se corrige.

## Pour explorer toi-même

- Lance `npm run hello` et appuie sur Ctrl+C au milieu : `SIGINT` déclenche
  `controller.abort()`, et le script sort par son `catch`.
- Observe le flux brut avec
  `curl -N -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Dis bonjour."}]}'`
  : `event: sources` d'abord (jour 2), puis les `delta`, puis `done`. Coupe
  avec Ctrl+C : le terminal de l'API affiche « client déconnecté,
  génération annulée ».
- Envoie `-d '{"messages":[]}'` avec `curl -i` : un `400` en JSON
  (« Il faut au moins un message. »), sans en-tête `text/event-stream`.
- Dans `llm/anthropic.ts`, ajoute `console.log(event.type)` en tête de la
  boucle `for await` : tu vois toute la séquence du SDK (`message_start`,
  `content_block_delta`… `message_stop`), dont seuls les `text_delta` sont
  relayés.
- Mets un point d'arrêt sur la ligne `onDelta` de `useChat.ts` et compare
  `prev` d'un appel à l'autre : chaque appel part du tableau précédent.
