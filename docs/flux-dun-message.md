# Cours : construire un chatbot en streaming avec React, Fastify et un LLM

> **À qui s'adresse ce cours.** À un étudiant qui connaît les bases de
> JavaScript, de React et de Node, mais qui n'a jamais branché un modèle de
> langage ni fait de streaming HTTP. Chaque leçon part d'une question,
> explique le concept, montre le code réel du projet, puis termine par un
> encadré « À retenir » et quelques questions pour vérifier ta compréhension.
>
> **Le fil rouge.** Nous allons suivre un seul message, « Explique les
> monorepos », depuis la touche Entrée jusqu'au rendu Markdown de la réponse.
> Tout le code cité est celui du dépôt, dans `apps/api` et `apps/web`.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit, et pourquoi dans cet ordre ? |
| 1 | Comment garder une clé API secrète dans une application web ? |
| 2 | Comment parler à un LLM sans coupler toute l'application à son SDK ? |
| 3 | Qu'est-ce que le streaming, et pourquoi en avons-nous besoin ? |
| 4 | Comment un serveur HTTP envoie-t-il un flux au navigateur ? (SSE) |
| 5 | Que se passe-t-il côté serveur quand un message arrive ? |
| 6 | Comment le navigateur lit-il un flux et le transforme-t-il en état React ? |
| 7 | Comment l'interface affiche-t-elle une réponse qui se construit ? |
| 8 | Que se passe-t-il quand ça se passe mal ? (Stop, erreurs, coupures) |
| 9 | Synthèse : le voyage complet d'un message |

---

## Leçon 0 : ce que nous avons construit

### Le projet en une phrase

Un chatbot où le navigateur envoie la conversation à un serveur Node, qui
interroge un modèle de langage (Claude, via l'API Anthropic) et renvoie la
réponse **au fur et à mesure qu'elle est générée**.

### L'architecture en un dessin

```
┌──────────────┐  HTTP   ┌──────────────┐  HTTP   ┌──────────────┐  HTTPS  ┌──────────────┐
│  Navigateur  │ ──────► │  Vite (5173) │ ──────► │ Fastify(3000)│ ──────► │ API Anthropic│
│  React       │ ◄────── │  proxy /api  │ ◄────── │ Node         │ ◄────── │ (Claude)     │
└──────────────┘  flux   └──────────────┘  flux   └──────────────┘  flux   └──────────────┘
    apps/web                                          apps/api
```

Trois acteurs, dont deux que nous écrivons :

- **apps/web** : l'interface React, servie par Vite en développement.
- **apps/api** : le serveur Fastify. C'est **lui seul** qui connaît la clé
  API et qui parle au modèle.
- **L'API Anthropic** : le service externe qui fait tourner le modèle.

### L'arborescence

```
chatbot/
├── package.json              # workspaces npm + scripts dev / typecheck / hello
├── tsconfig.base.json        # TypeScript strict partagé par les deux apps
└── apps/
    ├── api/
    │   ├── .env              # secrets (ignoré par git)
    │   ├── .env.example      # modèle à copier
    │   └── src/
    │       ├── config.ts         # Leçon 1
    │       ├── llm/              # Leçon 2
    │       │   ├── types.ts
    │       │   ├── anthropic.ts
    │       │   ├── factory.ts
    │       │   └── index.ts
    │       ├── sse.ts            # Leçon 4
    │       ├── prompts/system.ts # Leçon 5
    │       ├── routes/chat.ts    # Leçon 5
    │       ├── server.ts         # Leçon 5
    │       └── hello.ts          # script de test terminal
    └── web/
        ├── vite.config.ts        # Leçon 1 (proxy)
        └── src/chat/
            ├── types.ts
            ├── sse.ts            # Leçon 6
            ├── api.ts            # Leçon 6
            ├── useChat.ts        # Leçon 6
            ├── Chat.tsx          # Leçon 7
            ├── MessageList.tsx   # Leçon 7
            ├── MessageBubble.tsx # Leçon 7
            ├── Composer.tsx      # Leçon 7
            ├── ErrorBanner.tsx   # Leçon 8
            └── chat.css
```

### Pourquoi un monorepo ?

Deux applications, un seul dépôt, un seul `npm install`. Les
**workspaces npm** permettent d'avoir `apps/api/package.json` et
`apps/web/package.json` avec leurs propres dépendances, tout en partageant
`node_modules` et la configuration TypeScript à la racine. La commande
`npm run dev` à la racine lance les deux en parallèle avec `concurrently`.

> **À retenir**
> Le navigateur ne parle **jamais** directement au modèle. Tout passe par
> notre serveur. C'est la règle qui structure tout le reste du cours.

---

## Leçon 1 : garder un secret dans une application web

### Le problème

Appeler l'API Anthropic demande une clé. Tout ce qui est envoyé au
navigateur est lisible par l'utilisateur (onglet Réseau, Sources). Donc la
clé ne doit **jamais** quitter le serveur.

### Où vit la clé

Dans `apps/api/.env`, un fichier ignoré par git :

```
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-opus-5-5
```

Le `.gitignore` de la racine contient `.env` et `.env.*` avec une exception
pour `.env.example`, qui est le modèle à copier, sans valeur.

### Comment le serveur la lit (`apps/api/src/config.ts`)

Node 20.12+ sait lire un fichier `.env` nativement avec
`process.loadEnvFile()`. Pas besoin de la bibliothèque `dotenv`.

```ts
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

export function loadConfig(): Config {
  try {
    loadEnvFile(ENV_FILE);
  } catch (error) {
    // Fichier absent : on tolère, les variables peuvent venir de l'environnement.
    if (!isFileNotFound(error)) throw error;
  }

  const missing = REQUIRED_VARS.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      [
        `Variable(s) d'environnement manquante(s) : ${missing.join(", ")}.`,
        `Copie apps/api/.env.example vers apps/api/.env et renseigne les valeurs.`,
        `Fichier attendu : ${ENV_FILE}`,
      ].join("\n"),
    );
  }

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

Trois détails qui méritent une explication :

1. **`new URL("../.env", import.meta.url)`** calcule le chemin du `.env` à
   partir du fichier source lui-même, pas du répertoire courant. Que tu
   lances `npm run dev` depuis la racine ou depuis `apps/api`, le fichier
   est trouvé.
2. **Un fichier absent n'est pas une erreur** : en production, les
   variables viennent souvent de l'environnement du conteneur, pas d'un
   fichier. Ce qui est une erreur, c'est une variable manquante.
3. **Le message d'erreur dit quoi faire**. Un étudiant qui clone le dépôt et
   lance `npm run dev` lit immédiatement « copie `.env.example` ».

`server.ts` appelle `loadConfig()` avant toute autre chose et, en cas de
`ConfigError`, affiche le message et quitte avec `process.exit(1)`. Le
serveur refuse de démarrer à moitié configuré.

### Pourquoi le front ne peut pas voir la clé

- Vite n'injecte dans le code du navigateur que les variables préfixées
  `VITE_`. Il n'y a aucune variable de ce genre.
- `apps/web` n'a pas de fichier `.env` du tout.
- Le front n'appelle que `/api/...`, c'est-à-dire **notre** serveur.

### Le proxy Vite (`apps/web/vite.config.ts`)

```ts
server: {
  port: 5173,
  proxy: { "/api": "http://127.0.0.1:3000" },
}
```

En développement, le navigateur charge la page sur le port 5173. Quand le
code appelle `fetch("/api/chat")`, Vite reçoit la requête, voit le préfixe
`/api`, et la retransmet à Fastify sur le port 3000. La réponse revient par
le même chemin.

Deux bénéfices : pas de problème CORS (même origine pour le navigateur), et
des URL relatives dans le code, qui marcheront aussi en production derrière
un reverse proxy.

> **À retenir**
> Un secret vit dans un fichier ignoré par git, est lu par le serveur au
> démarrage, et le serveur refuse de démarrer s'il manque. Le navigateur ne
> voit que des URL relatives vers notre propre API.

**Questions**
1. Que se passe-t-il si tu renommes `LLM_API_KEY` en `VITE_LLM_API_KEY` et
   que tu le mets dans `apps/web/.env` ? Pourquoi est-ce grave ?
2. Pourquoi `loadConfig()` est-il appelé avant la création du serveur
   Fastify, et pas dans la route `/chat` ?

---

## Leçon 2 : parler à un LLM sans s'y enchaîner

### Le problème

Le SDK `@anthropic-ai/sdk` est très bien, mais si on l'importe partout, le
jour où l'on veut tester un autre fournisseur, ou simuler le modèle dans
un test, il faut tout réécrire. On veut une **frontière** : un seul fichier
connaît le SDK.

### L'outil : une interface

En TypeScript, une interface décrit ce qu'un objet sait faire, sans dire
comment. Voici la nôtre (`apps/api/src/llm/types.ts`) :

```ts
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export interface StreamChatParams {
  system?: string;        // instructions système (optionnel)
  messages: ChatMessage[]; // l'historique, le dernier étant celui à traiter
  signal?: AbortSignal;    // pour annuler la génération
}

export interface LlmClient {
  /** Renvoie la réponse sous forme de fragments de texte, au fil de l'eau. */
  streamChat(params: StreamChatParams): AsyncIterable<string>;
}
```

Lis bien le type de retour : **`AsyncIterable<string>`**. C'est « quelque
chose sur quoi on peut faire `for await (const morceau of ...)` et qui
donne des chaînes ». Pas de promesse d'une réponse complète : une suite de
fragments. Nous verrons en Leçon 3 pourquoi c'est le bon choix.

### L'implémentation (`apps/api/src/llm/anthropic.ts`)

```ts
import Anthropic from "@anthropic-ai/sdk";

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamChat({ system, messages, signal }: StreamChatParams): AsyncIterable<string> {
    const stream = this.client.messages.stream(
      { model: this.model, max_tokens: MAX_OUTPUT_TOKENS, system, messages },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason === "refusal") {
      throw new Error("Le modèle a refusé de répondre à cette requête.");
    }
  }
}
```

**Le mot-clé `async *`** déclare une *fonction génératrice asynchrone*.
C'est la façon native de JavaScript de produire un `AsyncIterable`. À
chaque `yield`, la fonction remet une valeur à l'appelant et se met en
pause jusqu'à ce qu'il en demande une autre. Elle ne construit jamais la
réponse complète en mémoire.

**Pourquoi filtrer sur `text_delta` ?** Le SDK émet beaucoup d'événements :
début de message, début de bloc, comptage de tokens, fin. Nous n'avons
besoin que du texte. Tout le reste est caché derrière l'interface : si
l'API change ses événements, seul ce fichier change.

**`{ signal }`** : le SDK accepte un `AbortSignal`. Si quelqu'un appelle
`abort()` dessus, la requête HTTP vers Anthropic est coupée. On verra en
Leçon 8 qui appuie sur ce bouton.

### La fabrique (`apps/api/src/llm/factory.ts`)

```ts
export function createLlmClient({ provider, apiKey, model }: LlmClientOptions): LlmClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicLlmClient(apiKey, model);
    default:
      throw new Error(`Fournisseur LLM inconnu : "${provider}". Valeurs possibles : anthropic.`);
  }
}
```

Une *fabrique* est une fonction qui choisit quelle classe instancier.
Ajouter un fournisseur demain : un nouveau fichier et un nouveau `case`.
Remarque qu'elle reçoit un objet d'options et pas `process.env` : la couche
LLM ne sait pas d'où vient la configuration, elle est donc réutilisable
telle quelle dans un test ou un script.

### Le point d'entrée (`apps/api/src/llm/index.ts`)

```ts
export type { ChatMessage, LlmClient, LlmClientOptions, StreamChatParams } from "./types.js";
export { createLlmClient } from "./factory.js";
```

La classe `AnthropicLlmClient` n'est **pas** exportée. Le reste de
l'application ne peut tout simplement pas y accéder. La frontière est
garantie par la structure du code, pas par une convention.

Tu peux le vérifier :

```bash
grep -rl '@anthropic-ai/sdk' apps/api/src
# → apps/api/src/llm/anthropic.ts, et rien d'autre
```

> **À retenir**
> Une interface décrit le besoin (« donne-moi des fragments de texte »), une
> classe l'implémente avec le SDK, une fabrique choisit la classe. Le reste
> du code ne voit que l'interface.

**Questions**
1. Si tu voulais écrire un `FakeLlmClient` qui renvoie toujours « Bonjour »
   pour tester l'interface sans clé API, que devrait-il implémenter ?
2. Pourquoi `streamChat` lève-t-elle une erreur après la boucle plutôt que
   de renvoyer une chaîne vide quand le modèle refuse ?

---

## Leçon 3 : qu'est-ce que le streaming, et pourquoi ?

### Sans streaming

Le serveur attend que le modèle ait écrit toute sa réponse, puis l'envoie
d'un bloc. Pour une réponse de 500 mots, l'utilisateur regarde un écran
vide pendant 10 à 20 secondes. En plus, un timeout HTTP peut tomber avant.

### Avec streaming

Le modèle produit son texte **token par token** (un token ≈ un morceau de
mot). Le serveur relaie chaque morceau dès qu'il arrive. L'utilisateur voit
les premiers mots en moins d'une seconde et peut lire pendant que la suite
s'écrit. Et s'il voit que la réponse part dans la mauvaise direction, il
peut l'arrêter sans attendre.

### Le streaming est un relais à trois maillons

```
Modèle ──(text_delta)──► Fastify ──(event: delta)──► Navigateur ──(setState)──► Écran
```

À chaque maillon, un fragment est transmis au suivant **sans attendre** le
fragment d'après. Si un seul maillon accumule avant de transmettre, tout le
bénéfice est perdu. C'est pourquoi :

- `LlmClient.streamChat` renvoie un `AsyncIterable` et non une `Promise<string>`.
- La route `/chat` écrit sur la réponse HTTP à chaque fragment (Leçon 5).
- Le navigateur lit le corps de la réponse morceau par morceau (Leçon 6).
- React met à jour l'état à chaque fragment (Leçon 7).

### Un script pour le voir (`apps/api/src/hello.ts`)

```ts
const llm = createLlmClient(config.llm);

for await (const chunk of llm.streamChat({
  messages: [{ role: "user", content: QUESTION }],
  signal: controller.signal,
})) {
  process.stdout.write(chunk);
}
```

Lance `npm run hello` : tu vois la réponse s'écrire dans le terminal. C'est
le premier maillon seul, sans HTTP ni React. Quand tu débogues, reviens
toujours à ce script : s'il marche, le problème est plus loin.

> **À retenir**
> Le streaming n'est pas une option d'affichage, c'est une contrainte de
> toute la chaîne : chaque étape doit transmettre immédiatement.

**Questions**
1. Si `streamChat` était déclarée `async streamChat(...): Promise<string>`,
   que faudrait-il changer dans la route `/chat` et dans le navigateur ?
2. Que signifie l'expression « token par token » ?

---

## Leçon 4 : comment un serveur envoie un flux au navigateur (SSE)

### Le problème

HTTP, à la base, c'est une requête, une réponse, fini. Comment envoyer
« un peu, puis un peu, puis un peu » sur une seule réponse ?

### La réponse HTTP est déjà un flux

Une réponse HTTP peut être envoyée en plusieurs morceaux (*chunked
transfer*). Le serveur écrit les en-têtes, puis du contenu, puis encore du
contenu, et ferme quand il a fini. Ce qu'il manque, c'est une **convention**
pour découper ce contenu en événements. C'est ce que fournit
**Server-Sent Events (SSE)**.

### Le format SSE

Un événement est un petit bloc de lignes texte, terminé par une ligne vide :

```
event: delta
data: {"text":"Un monorepo"}

event: delta
data: {"text":" est un dépôt"}

event: done
data: {}

```

- `event:` donne le nom de l'événement.
- `data:` porte le contenu (ici du JSON, mais SSE ne l'impose pas).
- **La ligne vide** est le séparateur. C'est elle que le parseur cherchera.

L'en-tête `Content-Type: text/event-stream` annonce ce format.

### Nos trois événements

| Événement | Données | Signification |
| --- | --- | --- |
| `delta` | `{ text }` | un fragment de la réponse |
| `done` | `{}` | la réponse est complète |
| `error` | `{ message }` | la génération a échoué après l'ouverture du flux |

### Le code (`apps/api/src/sse.ts`)

```ts
export function formatSseEvent({ event, data }: SseEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

Pourquoi `JSON.stringify` ? Parce que le texte d'un delta peut contenir des
sauts de ligne, et qu'un saut de ligne brut casserait le format (il serait
pris pour la fin de la ligne `data:`). JSON échappe les `\n` en `\\n` : la
ligne reste entière.

```ts
export function openSseStream(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
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

- `flushHeaders()` envoie les en-têtes **tout de suite**, avant le premier
  delta. Le navigateur sait qu'un flux arrive.
- `no-transform` et `X-Accel-Buffering: no` disent aux proxys (nginx…) de ne
  pas accumuler la réponse avant de la transmettre. Sans cela, un proxy mal
  réglé peut « dé-streamer » ta réponse.
- `isWritable()` : si le client est parti, écrire lèverait une erreur
  inutile. On ignore silencieusement.

> **À retenir**
> SSE n'est pas une technologie, c'est un format texte sur une réponse HTTP
> ordinaire. Un événement = des lignes `event:` / `data:` + une ligne vide.

**Questions**
1. Pourquoi ne pas envoyer simplement le texte brut, sans `event:` ni JSON ?
   Trouve deux cas qui poseraient problème.
2. Une fois les en-têtes envoyés avec le statut 200, peut-on encore répondre
   404 ou 500 ? Que fait-on à la place ?

---

## Leçon 5 : le serveur reçoit un message

Nous suivons maintenant notre message « Explique les monorepos » du côté
serveur. Il arrive en `POST /api/chat` avec ce corps :

```json
{ "messages": [{ "role": "user", "content": "Explique les monorepos" }] }
```

### Étape A : le serveur est prêt (`apps/api/src/server.ts`)

```ts
const config = loadConfigOrExit();
const llm = createLlmClient(config.llm);

const app = Fastify({ logger: true });

await app.register(
  async (api) => {
    api.get("/health", async () => ({ status: "ok" }));
    await api.register(chatRoutes, { llm });
  },
  { prefix: "/api" },
);

await app.listen({ port: config.port, host: "127.0.0.1" });
```

Le client LLM est créé **une fois** au démarrage et passé aux routes en
option. Le préfixe `/api` est posé ici : les routes se déclarent comme
`/health` et `/chat`, et deviennent `/api/health` et `/api/chat`.

### Étape B : valider le corps (`apps/api/src/routes/chat.ts`)

Ne jamais faire confiance à ce qui arrive du réseau. Fastify a déjà parsé
le JSON ; **Zod** vérifie maintenant la forme :

```ts
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Le contenu est vide.").max(MAX_CONTENT_LENGTH),
});

const chatRequestSchema = z.object({
  messages: z
    .array(chatMessageSchema)
    .min(1, "Il faut au moins un message.")
    .max(MAX_MESSAGES, `Au plus ${MAX_MESSAGES} messages par requête.`)
    .refine((messages) => messages.at(-1)?.role === "user", {
      message: 'Le dernier message doit avoir le rôle "user".',
    }),
});
```

Lis le schéma comme une phrase : « un objet avec un tableau `messages` de
1 à 50 éléments, chacun ayant un rôle `user` ou `assistant` et un contenu
non vide de 8 000 caractères max, et le dernier doit être un `user` ».

Remarque ce que le schéma **n'accepte pas** : un rôle `system`. Le client
ne peut donc pas injecter ses propres instructions système.

```ts
const parsed = chatRequestSchema.safeParse(request.body);
if (!parsed.success) {
  return reply.code(400).send({
    error: "Corps de requête invalide.",
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}
```

`safeParse` ne lance pas d'exception : il renvoie soit `{ success: true,
data }`, soit `{ success: false, error }`. En cas d'échec, on répond **400
en JSON ordinaire**. C'est possible parce que le flux SSE n'est pas encore
ouvert. Retiens cet ordre : *valider d'abord, streamer ensuite*.

Bonus de typage : après ce `if`, `parsed.data.messages` est du type
`ChatMessage[]`. Zod a fait la vérification à l'exécution, TypeScript en
profite à la compilation.

### Étape C : préparer l'annulation et ouvrir le flux

```ts
const controller = new AbortController();
reply.raw.once("close", () => controller.abort());

reply.hijack();
const sse = openSseStream(reply.raw);
```

Deux idées :

- **`reply.raw`** est l'objet réponse de Node, sous Fastify. Son événement
  `close` se déclenche quand la connexion avec le navigateur se ferme, pour
  quelque raison que ce soit. On y attache `controller.abort()`. Le signal
  de ce contrôleur ira au modèle : si le navigateur part, le modèle
  s'arrête. On y revient en Leçon 8.
- **`reply.hijack()`** dit à Fastify « je prends la main, n'essaie pas de
  sérialiser ma valeur de retour ni de fermer la réponse ». Sans cet appel,
  Fastify et nous écririons tous les deux sur la même réponse.

### Étape D : appeler le modèle et relayer

```ts
try {
  const stream = llm.streamChat({
    system: SYSTEM_PROMPT,
    messages: parsed.data.messages,
    signal: controller.signal,
  });
  for await (const text of stream) {
    sse.send({ event: "delta", data: { text } });
  }
  sse.send({ event: "done", data: {} });
} catch (error) {
  if (controller.signal.aborted) {
    request.log.info("client déconnecté, génération annulée");
  } else {
    request.log.error({ reason: describeError(error) }, "échec de la génération");
    sse.send({ event: "error", data: { message: GENERIC_ERROR_MESSAGE } });
  }
} finally {
  sse.close();
}
```

C'est le cœur du serveur, et il tient en quinze lignes :

1. Le **prompt système** est ajouté ici, depuis `prompts/system.ts`. Le
   client ne l'a jamais vu et ne peut pas le remplacer.
2. `for await` consomme le générateur de la Leçon 2. À chaque fragment, un
   événement `delta` part vers le navigateur. Aucun tampon.
3. Quand le générateur se termine, `done`.
4. En cas d'erreur, deux cas : le client est parti (on logue en info et on
   se tait), ou le modèle a échoué (on logue le détail technique **côté
   serveur** et on envoie un message générique au client).
5. `finally` ferme la réponse dans tous les cas.

### Ce que le serveur ne fait pas

- Il **ne stocke rien**. Pas de session, pas de base. L'historique arrive
  complet dans chaque requête et repart avec elle.
- Il **ne logue pas le contenu**. Le logger Fastify trace méthode, URL,
  statut. En cas d'erreur, seuls `error.name` et `error.message` sont
  écrits. Les messages des utilisateurs ne finissent pas dans un fichier de
  log.

> **À retenir**
> Valider (400 JSON) → attacher l'annulation à la fermeture de la connexion
> → prendre la main sur la réponse → relayer chaque fragment → `done` ou
> `error` → fermer. Le prompt système est ajouté côté serveur.

**Questions**
1. Si tu déplaçais la validation Zod après `openSseStream`, que recevrait le
   navigateur en cas de corps invalide ?
2. Pourquoi envoie-t-on un message d'erreur générique au client alors qu'on
   connaît la vraie cause ?

---

## Leçon 6 : le navigateur lit le flux

Changeons de côté. Le serveur envoie des événements SSE ; comment le code
React les reçoit-il et les transforme-t-il en état ?

### Pourquoi pas `EventSource` ?

Le navigateur a une API dédiée au SSE, `EventSource`. Mais elle ne sait
faire que des requêtes `GET` sans corps. Nous devons envoyer l'historique en
`POST`. On utilise donc `fetch` et on lit le corps de la réponse nous-mêmes.

### Étape A : la requête (`apps/web/src/chat/api.ts`)

```ts
const response = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages }),
  signal,
});

if (!response.ok) {
  throw new ChatError(await describeHttpError(response));
}
```

`fetch` se résout **dès que les en-têtes sont reçus**, pas à la fin de la
réponse. C'est ce qui rend le streaming possible : `response.body` est un
`ReadableStream` qu'on va lire au fur et à mesure.

Si le statut n'est pas 2xx (notre 400 de la Leçon 5, ou un 500), on lève
une erreur avec un message lisible, et on ne lit pas le corps comme un flux.

### Étape B : lire des octets

```ts
const reader = response.body.getReader();
const decoder = new TextDecoder();
const parser = createSseParser();
let completed = false;

while (!completed) {
  const { value, done } = await reader.read();
  if (done) break;

  for (const event of parser.push(decoder.decode(value, { stream: true }))) {
    switch (event.event) {
      case "delta":
        onDelta(parseJson<{ text: string }>(event.data).text);
        break;
      case "done":
        completed = true;
        break;
      case "error":
        throw new ChatError(parseJson<{ message: string }>(event.data).message);
    }
  }
}
```

Trois couches, de bas en haut :

1. **`reader.read()`** rend un paquet d'octets (`Uint8Array`). La taille et
   le découpage dépendent du réseau : un paquet peut contenir trois
   événements, ou la moitié d'un seul.
2. **`TextDecoder` en mode `{ stream: true }`** convertit en texte en se
   souvenant d'un éventuel caractère incomplet. Un « é » en UTF-8 fait deux
   octets ; s'ils arrivent dans deux paquets différents, le décodeur attend
   le second au lieu d'afficher un caractère cassé.
3. **Le parseur SSE** reconstitue les événements.

### Étape C : le parseur, ou comment gérer un événement coupé (`sse.ts`)

```ts
export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseEvent[] {
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

Suis un exemple à la main. Le serveur envoie :

```
event: delta\ndata: {"text":"Bonjour"}\n\n
```

Supposons que le réseau le coupe en deux paquets :

- Paquet 1 : `event: delta\ndata: {"te` → `push` cherche `\n\n`, ne le
  trouve pas, **ne renvoie rien** et garde tout dans `buffer`.
- Paquet 2 : `xt":"Bonjour"}\n\n` → `buffer` vaut maintenant l'événement
  complet, `\n\n` est trouvé, l'événement est renvoyé, `buffer` est vidé.

C'est le rôle de la variable `buffer`, qui survit entre deux appels grâce à
la *fermeture* (closure) : la fonction `push` « se souvient » de la
variable déclarée au-dessus d'elle.

`parseBlock` (non reproduit) lit les lignes `event:` et `data:` d'un bloc et
renvoie `{ event, data }`.

### Étape D : du flux à l'état React (`useChat.ts`)

Le hook `useChat` porte tout l'état du chat :

```ts
const [messages, setMessages] = useState<ChatMessage[]>([]);
const [status, setStatus] = useState<ChatStatus>("idle");   // "idle" | "streaming" | "error"
const [error, setError] = useState<string | null>(null);
const abortRef = useRef<AbortController | null>(null);
```

Et la fonction centrale, `run`, qui prend un historique terminé par un
message utilisateur :

```ts
const run = useCallback(async (history: ChatMessage[]) => {
  const controller = new AbortController();
  abortRef.current = controller;

  // Bulle assistant vide, remplie au fil des deltas.
  setMessages([...history, { role: "assistant", content: "" }]);
  setStatus("streaming");
  setError(null);

  try {
    await streamChat(history, controller.signal, (text) => {
      setMessages((prev) => appendToLastAssistant(prev, text));
    });
    setStatus("idle");
  } catch (err) {
    setMessages(dropEmptyTrailingAssistant);
    if (controller.signal.aborted) {
      setStatus("idle");          // arrêt volontaire : pas une erreur
    } else {
      setError(err instanceof Error ? err.message : "Erreur inconnue.");
      setStatus("error");
    }
  } finally {
    if (abortRef.current === controller) abortRef.current = null;
  }
}, []);
```

Le point le plus important de toute la partie front est ici :

```ts
setMessages((prev) => appendToLastAssistant(prev, text));
```

C'est la **forme fonctionnelle** de `setState`. Pourquoi pas
`setMessages([...messages, ...])` ? Parce que `messages` dans la fermeture
est la valeur **au moment où `run` a été appelé**. Les deltas arrivent
plusieurs fois par rendu ; si chacun partait de cette vieille valeur, il
écraserait les précédents et tu ne verrais que le dernier fragment. Avec
`prev => ...`, React te donne toujours l'état le plus récent.

```ts
function appendToLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), { ...last, content: last.content + text }];
}
```

On ne modifie jamais le tableau ni le message en place (pas de
`last.content += text`). On en recrée un nouveau, pour que React voie que
quelque chose a changé.

Enfin, `send` ne fait que préparer l'historique :

```ts
const send = useCallback((text: string) => {
  const content = text.trim();
  if (!content || status === "streaming") return;
  void run([...messages, { role: "user", content }]);
}, [messages, status, run]);
```

L'historique vit **uniquement** dans `messages`. Pas de `localStorage` :
recharger la page repart de zéro, c'est voulu.

> **À retenir**
> `fetch` → `reader.read()` (octets) → `TextDecoder` (texte) → parseur avec
> tampon (événements) → `setMessages(prev => ...)` (état). Chaque couche
> gère un type de découpage : réseau, caractères, événements, rendus.

**Questions**
1. Remplace mentalement `setMessages((prev) => ...)` par
   `setMessages([...messages, ...])`. Décris ce que l'utilisateur verrait.
2. Pourquoi le `TextDecoder` a-t-il besoin de l'option `{ stream: true }` ?
   Donne un exemple de caractère qui poserait problème sans elle.

---

## Leçon 7 : afficher une réponse qui se construit

### L'assemblage (`Chat.tsx`)

```tsx
export function Chat() {
  const { messages, status, error, send, stop, retry } = useChat();

  return (
    <div className="chat">
      <header className="chat__header"><h1>Chatbot</h1></header>
      <MessageList messages={messages} status={status} />
      {status === "error" && error && <ErrorBanner message={error} onRetry={retry} />}
      <Composer disabled={status === "streaming"} onSend={send} onStop={stop} />
    </div>
  );
}
```

Un seul composant appelle le hook. Les autres reçoivent des props. C'est le
schéma classique : l'état en haut, les composants d'affichage en bas.

### La saisie (`Composer.tsx`)

```tsx
const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
};
```

Entrée seule : on empêche le saut de ligne par défaut et on envoie.
Maj+Entrée : on laisse le navigateur insérer le saut de ligne. Le reste du
composant affiche soit Envoyer, soit Stop selon `disabled`, et désactive la
textarea pendant la génération.

### Le rendu d'un message (`MessageBubble.tsx`)

```tsx
{isUser ? (
  <p className="bubble__text">{message.content}</p>
) : (
  <div className="bubble__markdown">
    <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
    {streaming && <span className="bubble__cursor" aria-hidden="true" />}
  </div>
)}
```

Le texte de l'utilisateur est affiché tel quel. La réponse du modèle est
du Markdown, rendu par `react-markdown`. Une subtilité de sécurité :
`react-markdown` **n'interprète pas le HTML** contenu dans le Markdown. Si
le modèle écrit `<script>alert(1)</script>`, cela s'affiche comme du texte.
Le plugin `rehype-raw` permettrait d'activer le HTML ; nous ne l'installons
pas, précisément pour cette raison.

Le curseur clignotant n'est qu'un `span` en CSS, affiché quand `streaming`
est vrai, c'est-à-dire pour le dernier message pendant la génération.

### Le défilement (`MessageList.tsx`)

```tsx
const bottomRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  bottomRef.current?.scrollIntoView({ block: "end" });
}, [messages]);
```

Un `div` vide en bas de liste sert de cible. À chaque changement de
`messages` (donc à chaque delta), on y fait défiler. Note le tableau de
dépendances : **seulement `messages`**. On n'y met jamais une fonction
(`send`, `stop`…), qui changerait d'identité à chaque rendu et ferait
tourner l'effet pour rien.

### Pourquoi c'est fluide

Chaque delta provoque un `setMessages`, donc un re-rendu de la liste. React
regroupe les mises à jour proches dans le temps, et `react-markdown` ne
re-parse que le dernier message, qui est le seul à changer. À l'échelle
d'une conversation de quelques dizaines de messages, c'est imperceptible.

> **À retenir**
> Un composant porte l'état, les autres affichent. Le Markdown est rendu
> sans HTML brut. Le défilement est un effet qui ne dépend que des données.

**Questions**
1. Pourquoi le message utilisateur n'est-il pas rendu avec `react-markdown`
   lui aussi ?
2. Que se passerait-il si `useEffect` dépendait de `[messages, send]` ?

---

## Leçon 8 : quand ça se passe mal

Un bon système se juge à ses chemins d'erreur. Voici les quatre que nous
gérons, et le code correspondant.

### 8.1 L'utilisateur clique sur Stop

```ts
const stop = useCallback(() => {
  abortRef.current?.abort();
}, []);
```

Suis la chaîne :

1. `abort()` fait rejeter le `fetch` (ou le `reader.read()` en cours) avec
   une `AbortError`.
2. On tombe dans le `catch` de `run`. Le test `controller.signal.aborted`
   est vrai : on repasse en `idle`, **sans effacer le texte déjà reçu**.
   Si la bulle était encore vide, `dropEmptyTrailingAssistant` la retire.
3. Le navigateur ferme la connexion HTTP. Côté serveur, l'événement
   `close` de `reply.raw` déclenche l'autre `controller.abort()` (Leçon 5).
4. Le SDK coupe la requête vers Anthropic. Le modèle arrête de générer.
   On ne paie pas une réponse que personne ne lira.
5. Le `catch` de la route voit `signal.aborted`, logue « client
   déconnecté » et ferme.

Deux `AbortController`, un par côté, reliés par la fermeture de la
connexion. C'est le schéma à mémoriser.

Le texte partiel reste dans l'historique et sera envoyé au modèle au tour
suivant, comme un tour assistant interrompu. Le modèle voit ce que
l'utilisateur a vu.

### 8.2 Erreur HTTP : serveur arrêté, corps refusé

`fetch` reçoit une réponse non 2xx. `describeHttpError` fabrique le message :

```ts
async function describeHttpError(response: Response): Promise<string> {
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as { issues?: { message: string }[] } | null;
    const detail = body?.issues?.[0]?.message;
    return detail ? `Requête refusée : ${detail}` : "Requête refusée par le serveur.";
  }
  return `Erreur du serveur (HTTP ${response.status}).`;
}
```

Pour un 400, on affiche le premier message Zod. Si l'API est éteinte, c'est
Vite qui répond 500 (il n'a pas réussi à joindre le backend), d'où « Erreur
du serveur (HTTP 500) ».

La `ChatError` remonte dans le `catch` de `run`, `status` devient `"error"`,
`Chat.tsx` affiche le bandeau.

### 8.3 Erreur après l'ouverture du flux

Le serveur a déjà envoyé 200 et des en-têtes SSE. Il ne peut plus changer
le statut. Il envoie donc un événement `error` (Leçon 5), et côté
navigateur :

```ts
case "error":
  throw new ChatError(parseJson<{ message: string }>(event.data).message);
```

Même chemin ensuite qu'en 8.2.

### 8.4 Coupure réseau au milieu du flux

Ni `done`, ni `error` : la connexion tombe. `reader.read()` renvoie
`done: true` et la boucle sort avec `completed === false` :

```ts
if (!completed) {
  throw new ChatError("La connexion s'est interrompue avant la fin de la réponse.");
}
```

Sans ce test, une coupure ressemblerait à une fin normale et l'utilisateur
ne saurait pas que la réponse est tronquée.

### 8.5 Réessayer

```ts
const retry = useCallback(() => {
  if (status === "streaming") return;
  const history = trimToLastUserMessage(messages);
  if (history.length === 0) return;
  void run(history);
}, [messages, status, run]);
```

`trimToLastUserMessage` retire les messages assistant en fin de liste (la
réponse incomplète), pour que l'historique se termine par le dernier
message de l'utilisateur. Puis `run` repart comme un envoi normal.
L'utilisateur n'a rien à retaper.

### 8.6 La machine à états du hook

```
          send() / retry()
 idle ─────────────────────► streaming
  ▲                             │
  │  "done" reçu, ou Stop       │ HTTP non 2xx / event "error" / flux tronqué
  └─────────────────────────────┤
                                ▼
                              error ──retry()──► streaming
```

Trois états, cinq transitions. Quand tu ajoutes une fonctionnalité,
demande-toi d'abord quelle transition elle ajoute à ce schéma.

> **À retenir**
> Stop n'est pas une erreur. Une erreur HTTP arrive avant le flux, une
> erreur SSE pendant, une coupure sans rien. Les trois convergent vers
> `status = "error"` et le bouton Réessayer.

**Questions**
1. Pourquoi faut-il **deux** `AbortController`, et pas un seul partagé ?
2. Si tu retirais `setMessages(dropEmptyTrailingAssistant)` du `catch`,
   qu'afficherait l'interface après un Stop immédiat ?

---

## Leçon 9 : synthèse, le voyage complet d'un message

Reprends le fil rouge et vérifie que tu peux raconter chaque étape sans
regarder le code.

```
Navigateur                          Vite (5173)      Fastify (3000)        API Anthropic
   │                                     │                 │                     │
   │ 1  Entrée dans Composer             │                 │                     │
   │ 2  send() → run()                   │                 │                     │
   │ 3  bulle vide, status=streaming     │                 │                     │
   │ 4  fetch POST /api/chat ───────────►│ 5 proxy ───────►│                     │
   │                                     │                 │ 6  Zod safeParse    │
   │                                     │                 │ 7  close→abort,     │
   │                                     │                 │    hijack, en-têtes │
   │                                     │                 │ 8  streamChat ─────►│
   │                                     │                 │◄── text_delta ──────│
   │◄── event: delta ────────────────────│◄────────────────│ 9  sse.send         │
   │ 10 read → decode → parse → onDelta  │                 │                     │
   │ 11 setMessages(prev=>…) → rendu     │                 │     (répété)        │
   │◄── event: done ─────────────────────│◄────────────────│ 12 fin, close()     │
   │ 13 completed → status=idle          │                 │                     │
```

| # | Où | Ce qui se passe | Leçon |
| --- | --- | --- | --- |
| 1 | `Composer.tsx` | Entrée sans Maj : `preventDefault`, `onSend(draft)` | 7 |
| 2 | `useChat.ts` | `send` ajoute le message user à l'historique et appelle `run` | 6 |
| 3 | `useChat.ts` | `AbortController` créé, bulle assistant vide, `status = "streaming"` | 6 |
| 4 | `api.ts` | `fetch("/api/chat", { method: "POST", body, signal })` | 6 |
| 5 | `vite.config.ts` | `/api` relayé vers `127.0.0.1:3000` | 1 |
| 6 | `routes/chat.ts` | Zod `safeParse` ; 400 JSON si invalide | 5 |
| 7 | `routes/chat.ts`, `sse.ts` | `close → abort`, `hijack`, en-têtes `text/event-stream` | 4, 5 |
| 8 | `llm/anthropic.ts` | `client.messages.stream(...)`, `yield` des `text_delta` | 2 |
| 9 | `routes/chat.ts` | `sse.send({ event: "delta", data: { text } })` | 5 |
| 10 | `api.ts`, `sse.ts` | `reader.read` → `TextDecoder` → parseur avec tampon | 6 |
| 11 | `useChat.ts`, `MessageBubble.tsx` | `setMessages(prev => …)`, rendu Markdown, défilement | 6, 7 |
| 12 | `routes/chat.ts` | `done` puis `finally { sse.close() }` | 5 |
| 13 | `api.ts`, `useChat.ts` | `completed = true`, `status = "idle"`, saisie réactivée | 6 |

### Les six idées à emporter

1. **Le navigateur ne parle jamais au modèle.** La clé vit sur le serveur.
2. **Une interface isole le fournisseur.** Un fichier connaît le SDK.
3. **Le streaming est une contrainte de chaîne.** Chaque maillon transmet
   immédiatement : générateur, `res.write`, `reader.read`, `setState`.
4. **SSE = lignes `event:`/`data:` + ligne vide.** Le parseur garde un tampon
   pour les événements coupés.
5. **Valider avant de streamer.** Le 400 n'est possible que tant que les
   en-têtes ne sont pas partis.
6. **Deux `AbortController`.** Celui du navigateur coupe le `fetch`, celui du
   serveur coupe le modèle quand la connexion se ferme.

### Pour aller plus loin (non fait, volontairement)

- **Historique trop long** : la limite est de 50 messages. Il faudra un jour
  tronquer côté front ou résumer côté serveur.
- **Production** : Vite disparaît. Il faut servir le build statique et faire
  pointer `/api` vers Fastify via un reverse proxy, en gardant le streaming
  (pas de mise en tampon pour `text/event-stream`).
- **Tests** : la couche `LlmClient` se prête à un faux client ; le parseur
  SSE à des tests unitaires sur des découpages arbitraires.

### Commandes pour expérimenter

```bash
npm run dev          # api :3000 + web :5173
npm run typecheck    # TypeScript strict sur les deux apps
npm run hello        # le premier maillon seul, dans le terminal

# Voir le flux SSE brut, événement par événement
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Dis bonjour."}]}'

# Provoquer un 400
curl -i -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"assistant","content":"x"}]}'
```

Exercice final : lance le `curl -N`, puis coupe-le avec Ctrl+C après le
premier delta. Va lire le log de l'API et trouve la ligne qui prouve que le
modèle a été arrêté. Tu viens de vérifier la Leçon 8 toi-même.
