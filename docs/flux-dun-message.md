# Cours : construire un chatbot en streaming avec React, Fastify et un LLM

> **À qui s'adresse ce cours.** À un étudiant qui connaît les bases de
> JavaScript, de React et de Node, mais qui n'a jamais branché un modèle de
> langage ni fait de streaming HTTP. Chaque leçon part d'une question,
> explique le concept, montre le code réel du projet, puis termine par un
> encadré « À retenir » et quelques questions pour vérifier ta compréhension.
> Les réponses sont regroupées dans le **Corrigé des questions**, tout à la
> fin : essaie d'abord, compare ensuite.
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
| Corrigé | Réponses détaillées aux questions de chaque leçon |

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

---

## Corrigé des questions

> Essaie de répondre par écrit avant de lire. Une réponse qui tient en deux
> phrases et qui cite le bon fichier vaut mieux qu'une longue paraphrase.

### Leçon 1 : garder un secret

**1. Si tu renommes `LLM_API_KEY` en `VITE_LLM_API_KEY` et que tu le mets
dans `apps/web/.env`, que se passe-t-il, et pourquoi est-ce grave ?**

Vite expose au code du navigateur toutes les variables qui commencent par
`VITE_`, via `import.meta.env.VITE_LLM_API_KEY`. Elles sont remplacées
textuellement dans le bundle JavaScript au moment du build. La clé se
retrouve donc en clair dans un fichier `.js` téléchargé par chaque
visiteur : un clic droit « Afficher la source » ou l'onglet Réseau des
outils de développement suffit à la lire.

C'est grave parce qu'une clé API est un moyen de paiement. Quiconque la
récupère peut l'utiliser à tes frais jusqu'à révocation, et tu n'as aucun
moyen de distinguer ses appels des tiens. Le préfixe `VITE_` est précisément
le signal « ceci est public » ; une clé ne doit jamais le porter. Dans notre
projet, aucun fichier de `apps/web` ne lit la clé : le navigateur appelle
`/api/chat`, et c'est `apps/api` qui la détient (Leçon 1, `config.ts`).

**2. Pourquoi `loadConfig()` est-il appelé avant la création du serveur
Fastify, et pas dans la route `/chat` ?**

Pour échouer tôt et une seule fois. Si la configuration est lue au
démarrage, une variable manquante arrête le processus avec un message
clair avant que le serveur n'écoute : impossible de déployer une API
« à moitié configurée » qui répondrait `200` sur `/health` et planterait au
premier vrai appel.

Lire la configuration dans la route poserait trois problèmes. L'erreur
n'apparaîtrait qu'au premier utilisateur, sous forme d'un `500` opaque. On
relirait le fichier et les variables à chaque requête, pour rien. Et la
route devrait gérer un cas (« la clé n'existe pas ») qui n'a aucun sens une
fois le serveur lancé. C'est pourquoi `server.ts` fait
`loadConfigOrExit()` puis `createLlmClient(config.llm)` une fois, et passe
le client déjà construit au plugin de routes.

### Leçon 2 : parler à un LLM sans s'y enchaîner

**1. Un `FakeLlmClient` qui renvoie toujours « Bonjour », que devrait-il
implémenter ?**

Uniquement l'interface `LlmClient` de `llm/types.ts`, c'est-à-dire une seule
méthode `streamChat(params)` qui renvoie un `AsyncIterable<string>`. La
façon la plus courte est un générateur asynchrone :

```ts
import type { LlmClient, StreamChatParams } from "./types.js";

export class FakeLlmClient implements LlmClient {
  async *streamChat(_params: StreamChatParams): AsyncIterable<string> {
    yield "Bon";
    yield "jour";
  }
}
```

Il n'a besoin ni de clé, ni de SDK, ni de réseau. Deux `yield` plutôt qu'un
seul permettent de vérifier que la route et le navigateur gèrent bien
plusieurs fragments. Pour l'utiliser, il suffirait d'ajouter un
`case "fake"` dans `factory.ts` : la route `/chat`, le script `hello` et le
front ne changent pas d'une ligne. C'est tout l'intérêt de la Leçon 2 : le
reste du code ne connaît que l'interface.

**2. Pourquoi `streamChat` lève-t-elle une erreur après la boucle plutôt que
de renvoyer une chaîne vide quand le modèle refuse ?**

Parce qu'un refus n'est pas une réponse vide, c'est un échec, et les deux
ne doivent pas être traités pareil. Si le générateur se terminait
silencieusement, la route enverrait `done`, le navigateur passerait en
`idle`, et l'utilisateur verrait une bulle assistant vide sans
explication ni bouton Réessayer. Il croirait à un bug d'affichage.

En lançant une erreur, on fait remonter l'information par le canal prévu :
la route tombe dans son `catch`, logue la raison, envoie un événement SSE
`error`, et le hook `useChat` passe en `status = "error"` avec le bandeau.
Une interface doit dire ce qui ne va pas plutôt que de faire semblant que
tout s'est bien passé. Détail technique : on ne connaît le `stop_reason`
qu'à la fin, via `stream.finalMessage()`, d'où la position de ce test après
la boucle.

### Leçon 3 : qu'est-ce que le streaming ?

**1. Si `streamChat` était déclarée `async streamChat(...): Promise<string>`,
que faudrait-il changer dans la route `/chat` et dans le navigateur ?**

Côté serveur, le `for await (const delta of stream)` de `routes/chat.ts`
n'aurait plus de sens : il n'y aurait qu'une seule valeur, disponible à la
fin. La route attendrait la réponse complète puis l'enverrait d'un bloc. Le
SSE lui-même deviendrait inutile ; un simple `reply.send({ text })` en JSON
ferait l'affaire.

Côté navigateur, tout le pipeline `reader.read()` → `TextDecoder` →
parseur SSE disparaîtrait au profit d'un `await response.json()`. Le hook
afficherait la bulle d'un coup au lieu de l'allonger delta par delta, et le
bouton Stop ne pourrait plus « garder le texte déjà reçu » puisque rien
n'arrive avant la fin.

Ce que la question veut te faire remarquer : le type de retour d'une seule
méthode conditionne l'architecture de toute la chaîne. Choisir
`AsyncIterable<string>` plutôt que `Promise<string>` est la décision qui
rend le streaming possible, et elle se prend au point le plus bas, dans
`llm/types.ts`.

**2. Que signifie l'expression « token par token » ?**

Un modèle de langage ne produit pas des lettres ni des mots, mais des
**tokens** : des morceaux de texte d'un vocabulaire fixe, souvent un mot
courant entier, parfois un fragment (« mono » + « repo ») ou un signe de
ponctuation. Il les génère un par un, chaque token dépendant de tous les
précédents. « Token par token » désigne donc le rythme naturel de la
génération.

Streamer, c'est transmettre ce rythme au lieu de le cacher. En pratique,
l'API regroupe parfois quelques tokens dans un même événement
`content_block_delta`, et le réseau peut recoller plusieurs événements dans
un seul paquet. C'est pourquoi notre code ne suppose jamais « un delta = un
token = un mot » : il traite des fragments de texte de taille quelconque.

### Leçon 4 : Server-Sent Events

**1. Pourquoi ne pas envoyer simplement le texte brut, sans `event:` ni
JSON ? Deux cas qui poseraient problème.**

Premier cas : **distinguer le texte du reste**. Si le modèle écrit « La
génération a échoué », comment le navigateur sait-il s'il s'agit de la
réponse ou d'une erreur serveur ? Sans canal séparé, il faudrait inventer
un marqueur dans le texte, qu'un utilisateur pourrait reproduire en le
tapant lui-même. Les lignes `event: delta` / `event: error` / `event: done`
règlent le problème : le type est hors du contenu.

Deuxième cas : **le contenu lui-même**. Une réponse Markdown contient des
sauts de ligne, et le format SSE utilise justement la ligne vide comme
séparateur d'événements. Un paragraphe suivi d'une ligne vide serait pris
pour la fin d'un événement. Encoder le texte en JSON (`{"text":"...\n\n..."}`)
transforme ces sauts de ligne en `\n` littéraux sur une seule ligne, et le
parseur fait l'inverse à l'arrivée. Le JSON protège aussi les espaces en
début de fragment, que SSE ignorerait sinon après `data:`.

Une raison bonus : savoir que la réponse est **terminée**. Sans événement
`done`, une connexion fermée pourrait signifier « fini » ou « coupée en
plein milieu ». La Leçon 8 s'appuie précisément sur cette différence.

**2. Une fois les en-têtes envoyés avec le statut 200, peut-on encore
répondre 404 ou 500 ? Que fait-on à la place ?**

Non. HTTP envoie la ligne de statut et les en-têtes en premier, puis le
corps. Dès que `flushHeaders()` est parti, le `200` est écrit sur la prise
réseau et le navigateur l'a déjà lu : aucun moyen de le rappeler. Tenter
`res.statusCode = 500` après coup lève une erreur
`ERR_HTTP_HEADERS_SENT` dans Node.

À la place, on fait passer l'erreur **dans le corps**, comme un événement
parmi les autres : `event: error` avec un `data` JSON, puis on ferme le
flux. C'est le rôle de `sse.send({ type: "error", ... })` dans le `catch` de
la route. Le navigateur, lui, ne regarde plus le statut HTTP à ce stade ; il
réagit au type d'événement. Cette contrainte explique aussi la réponse à la
question suivante : tout ce qui peut échouer **avant** le flux, comme la
validation, doit être fait avant d'ouvrir le flux, pendant qu'un vrai
`400` est encore possible.

### Leçon 5 : le serveur reçoit un message

**1. Si tu déplaçais la validation Zod après `openSseStream`, que recevrait
le navigateur en cas de corps invalide ?**

Un `200 OK` avec `Content-Type: text/event-stream`, puis soit rien (si tu
fermais simplement), soit un événement `error` dans le flux. Jamais de
`400`, pour la raison vue à la Leçon 4 : les en-têtes sont partis.

Conséquences concrètes dans notre front. `api.ts` teste d'abord
`response.ok` : il serait vrai, donc la branche `describeHttpError` qui
affiche « Requête refusée : … » avec le premier problème Zod ne
s'exécuterait jamais. L'utilisateur verrait au mieux le message générique
« La génération a échoué », au pire « La connexion s'est interrompue avant
la fin de la réponse », sans savoir que c'est son message qui était trop
long. Et le serveur aurait ouvert un flux, créé un `AbortController` et
pris la main sur la réponse pour une requête qu'il allait rejeter de toute
façon. Règle : **tout ce qui peut produire un statut HTTP se décide avant
`hijack()`**.

**2. Pourquoi envoie-t-on un message d'erreur générique au client alors
qu'on connaît la vraie cause ?**

Pour deux raisons, sécurité et responsabilité.

Sécurité : la vraie cause vient souvent du SDK ou de l'API distante.
Son message peut contenir l'URL appelée, le nom du modèle, un identifiant
de requête, un extrait de la réponse HTTP, parfois des indices sur la
configuration du serveur. Tout ce qu'on écrit dans l'événement `error`
atterrit chez un inconnu, dans son navigateur. On ne divulgue rien qu'on ne
voudrait pas voir dans une capture d'écran publique.

Responsabilité : l'utilisateur ne peut rien faire d'un `401 invalid
x-api-key` ou d'un `529 overloaded`. Ce n'est pas son problème, c'est le
nôtre. Le message utile pour lui est « ça a échoué, réessaie » ; le message
utile pour nous est la cause complète, et elle va au bon endroit : le log
serveur, via `request.log.error({ reason })`. L'exception à cette règle est
le `400` : là, la cause (« le dernier message doit avoir le rôle user »)
concerne bien le client, et on la lui donne.

### Leçon 6 : le navigateur lit le flux

**1. Remplace `setMessages((prev) => ...)` par
`setMessages([...messages, ...])`. Que verrait l'utilisateur ?**

Il verrait la réponse **ne pas s'afficher**, ou s'afficher par à-coups
incohérents, et la plupart du temps rester vide jusqu'à la fin.

Explication. La fonction `run` est créée par `useCallback` avec `[]` comme
dépendances : elle capture la variable `messages` telle qu'elle était au
premier rendu, c'est-à-dire un tableau vide ou l'historique d'avant l'envoi.
La fonction de rappel `onDelta` qu'on passe à `streamChat` est créée dans
`run`, donc elle voit la même valeur figée. À chaque delta, elle calculerait
`[...messagesFigés, bulleAvecCeDeltaSeul]` : le texte n'est jamais
accumulé, chaque fragment écrase le précédent, et la bulle assistant vide
créée au début de `run` est perdue. C'est le problème classique de la
**fermeture périmée** (stale closure).

La forme fonctionnelle `setMessages((prev) => ...)` demande à React de nous
donner **l'état réel au moment où la mise à jour s'applique**, quel que soit
l'âge de la fermeture. React garantit aussi que ces fonctions s'exécutent
dans l'ordre d'appel, donc deux deltas arrivant très vite ne se perdent
pas. Règle à retenir : quand la nouvelle valeur dépend de l'ancienne, et a
fortiori depuis un rappel asynchrone, toujours la forme fonctionnelle.

**2. Pourquoi `TextDecoder` a-t-il besoin de `{ stream: true }` ? Exemple
de caractère problématique.**

Parce que le réseau découpe en **octets**, pas en caractères, et qu'en
UTF-8 un caractère peut occuper de un à quatre octets. Rien n'empêche un
paquet de se terminer au milieu d'un caractère.

Exemple : le « é » de « génération » s'écrit en UTF-8 sur deux octets,
`C3 A9`. Si le premier paquet se termine par `C3` et le second commence par
`A9`, un décodeur sans mémoire traiterait `C3` seul comme une séquence
invalide et produirait le caractère de remplacement « � », puis `A9` seul
produirait un second « � ». L'utilisateur lirait « g��nération ». Un emoji
(quatre octets) ou un « — » (trois octets) ont trois fois plus de chances
de tomber sur une coupure.

Avec `{ stream: true }`, le décodeur **garde les octets incomplets** en
attendant le paquet suivant, et n'émet le caractère que quand il est
entier. C'est exactement le même principe que le tampon du parseur SSE,
une couche plus bas : le réseau coupe où il veut, chaque couche recolle ce
qui la concerne.

### Leçon 7 : afficher une réponse qui se construit

**1. Pourquoi le message utilisateur n'est-il pas rendu avec
`react-markdown` lui aussi ?**

Parce que ce n'est pas du Markdown, c'est ce que la personne a tapé, et
elle s'attend à le revoir tel quel. Si elle écrit « utilise *args dans la
fonction » ou colle un bout de code avec des `#` et des `_`, un rendu
Markdown transformerait son texte : italique inattendu, titres géants,
listes involontaires. Elle penserait que son message a été altéré avant
envoi.

Il y a aussi un argument de simplicité et de confiance : l'assistant
produit volontairement du Markdown (le prompt système le lui demande), donc
le rendre a du sens. Le texte utilisateur n'a pas de format défini. Un
`<p>` avec `white-space: pre-wrap` conserve ses sauts de ligne, ce qui est
tout ce qu'il attend. Enfin, moins on interprète ce qui vient de
l'utilisateur, moins on ouvre de surface à des rendus surprenants.

**2. Que se passerait-il si `useEffect` dépendait de `[messages, send]` ?**

Dans notre code précis, probablement rien de visible, et c'est ce qui rend
l'erreur dangereuse. `send` est recréé par `useCallback` à chaque fois que
`messages` ou `status` change. Il changerait donc en même temps que
`messages`, ou légèrement plus souvent (au passage `idle` → `streaming`),
et l'effet défilerait une ou deux fois de trop. Pas de boucle infinie ici,
parce que l'effet ne modifie pas d'état.

Mais c'est une mauvaise habitude pour trois raisons. D'abord, le défilement
n'a **aucun rapport** avec `send` : la liste de dépendances doit dire « cet
effet réagit à ceci », et mentir sur cette liste rend le code illisible.
Ensuite, dès qu'un composant parent ne mémorise pas la fonction qu'il passe
(ou si on la remplace un jour par une fonction inline), elle change à
**chaque rendu** : l'effet s'exécute à chaque rendu, et s'il touche à
l'état, on obtient la boucle infinie classique. Enfin, pour une fonction de
traduction `t` ou un lanceur d'action, c'est exactement le même piège :
ces fonctions sont des outils, pas des données. On ne met dans les
dépendances que ce dont le résultat de l'effet dépend réellement, ici
`messages`.

### Leçon 8 : quand ça se passe mal

**1. Pourquoi faut-il deux `AbortController`, et pas un seul partagé ?**

Parce qu'un `AbortController` est un objet JavaScript qui vit dans **un
seul processus**. Celui du navigateur existe dans l'onglet ; celui du
serveur existe dans Node, sur une autre machine en production. Aucun des
deux ne peut appeler `abort()` sur l'autre : il n'y a pas de mémoire
partagée entre un navigateur et un serveur.

Chacun contrôle donc ce qui est à sa portée. Le contrôleur du navigateur
coupe le `fetch`, ce qui ferme la connexion HTTP. Cette fermeture est le
**seul signal** qui traverse le réseau. Côté serveur, `reply.raw.once("close")`
reçoit ce signal et déclenche le second contrôleur, qui coupe la requête
du SDK vers Anthropic. Les deux contrôleurs sont donc reliés, mais par la
connexion, pas par une référence.

Ce découplage a une vertu supplémentaire : le serveur annule le modèle
pour **toute** fermeture, pas seulement un clic sur Stop. Onglet fermé,
Wi-Fi coupé, navigateur planté : dans tous les cas, on arrête de payer des
tokens pour une réponse que personne ne lira.

**2. Si tu retirais `setMessages(dropEmptyTrailingAssistant)` du `catch`,
qu'afficherait l'interface après un Stop immédiat ?**

Une **bulle assistant vide** resterait dans la liste, sous le message de
l'utilisateur. Rappel du déroulement : `run` ajoute d'abord
`{ role: "assistant", content: "" }` pour que la bulle apparaisse tout de
suite, puis la remplit au fil des deltas. Si on clique Stop avant le
premier delta, aucun texte n'arrive, le `fetch` est rejeté, on passe dans
le `catch` avec `status = "idle"`, et la bulle vide est toujours là.

Visuellement : une boîte grise sans rien dedans, sans curseur puisque le
streaming est terminé. Pire, le prochain envoi inclurait ce message vide
dans l'historique envoyé au serveur, et Zod le refuserait avec « Le contenu
est vide » : l'utilisateur serait bloqué par un `400` qu'il ne comprend
pas. Le même problème se poserait après une erreur HTTP immédiate, par
exemple API arrêtée.

`dropEmptyTrailingAssistant` ne retire que la dernière bulle **si elle est
assistant et vide**. Si Stop arrive après quelques deltas, la bulle a du
contenu et elle est conservée : c'est le comportement demandé, « garder le
texte déjà reçu ».
