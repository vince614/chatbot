# Jour 1 · Cours 1 — Construire un chatbot en streaming avec React, Fastify et un LLM

> [Sommaire](README.md) · Suivant : [Jour 1 · Cours 2 — Le tool use](jour-1-appel-doutils.md) · [Approfondissement : le code](approfondissement/jour-1-flux-dun-message.md)

> **À qui s'adresse ce cours.** À un étudiant qui connaît les bases de
> JavaScript, de React et de Node, mais qui n'a jamais branché un modèle de
> langage ni fait de streaming HTTP. Les réponses aux questions sont dans le
> **Corrigé**, à la fin : essaie d'abord, compare ensuite.
>
> **Le fil rouge.** Nous suivons un seul message, « Explique les
> monorepos », depuis la touche Entrée jusqu'au rendu Markdown de la réponse.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Comment garder une clé API secrète dans une application web ? |
| 2 | Comment parler à un LLM sans coupler l'application à son SDK ? |
| 3 | Pourquoi streamer, et comment envoyer un flux au navigateur (SSE) ? |
| 4 | Que fait le serveur quand un message arrive ? |
| 5 | Comment le navigateur transforme-t-il le flux en état React ? |
| 6 | Comment l'interface affiche-t-elle une réponse qui se construit ? |
| 7 | Quand ça se passe mal |
| 8 | Synthèse |

---

## Leçon 0 : ce que nous avons construit

Un chatbot où le navigateur envoie la conversation à un serveur Node, qui
interroge Claude via l'API Anthropic et renvoie la réponse **au fur et à
mesure qu'elle est générée**.

```
Navigateur ──► Vite (5173) ──► Fastify (3000) ──► API Anthropic
 apps/web      proxy /api       apps/api
   ◄──────────── flux ◄──────────── flux ◄──────────── flux
```

- **apps/web** : l'interface React, servie par Vite en développement
  (`src/chat/` : `useChat.ts`, `api.ts`, `sse.ts`, les composants).
- **apps/api** : le serveur Fastify (`config.ts`, `llm/`, `sse.ts`,
  `routes/chat.ts`, `server.ts`, `hello.ts`). Lui seul connaît la clé.
- Un monorepo avec **workspaces npm** : un seul `npm install`, et
  `npm run dev` lance les deux apps en parallèle avec `concurrently`.

> **À retenir**
> Le navigateur ne parle **jamais** directement au modèle. Tout passe par
> notre serveur.

---

## Leçon 1 : garder un secret

Appeler l'API Anthropic demande une clé. Tout ce qui est envoyé au
navigateur est lisible par l'utilisateur. La clé ne doit donc jamais
quitter le serveur.

```ts
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
```

- La clé vit dans `apps/api/.env`, ignoré par git ; `.env.example` sert de
  modèle. Node la lit nativement avec `process.loadEnvFile()`, sans `dotenv`.
- Un fichier `.env` absent est toléré (les variables peuvent venir de
  l'environnement) ; une variable manquante, non.
- `server.ts` appelle `loadConfig()` avant tout : le serveur refuse de
  démarrer à moitié configuré, avec un message qui dit quoi faire.
- Côté front : aucune variable `VITE_`, pas de `.env`, et un proxy Vite
  (`"/api": "http://127.0.0.1:3000"`) qui évite CORS et permet des URL
  relatives.

> **À retenir**
> Le secret est lu par le serveur au démarrage. Le navigateur ne voit que
> des URL relatives vers notre propre API.

**Questions**
1. Que se passe-t-il si tu renommes `LLM_API_KEY` en `VITE_LLM_API_KEY` et
   que tu le mets dans `apps/web/.env` ? Pourquoi est-ce grave ?

---

## Leçon 2 : parler à un LLM sans s'y enchaîner

Si l'on importe le SDK `@anthropic-ai/sdk` partout, changer de fournisseur
ou simuler le modèle dans un test oblige à tout réécrire. On veut une
frontière : un seul fichier connaît le SDK.

```ts
export interface LlmClient {
  /** Renvoie la réponse sous forme de fragments de texte, au fil de l'eau. */
  streamChat(params: StreamChatParams): AsyncIterable<string>;
}
```

- Le type de retour `AsyncIterable<string>` est une suite de fragments
  qu'on consomme avec `for await`, pas une réponse complète.
- `AnthropicLlmClient` l'implémente avec une fonction génératrice
  `async *` : elle `yield` uniquement les événements `text_delta` du SDK.
- Si le modèle refuse (`stop_reason === "refusal"`), elle lève une erreur.
- Une fabrique `createLlmClient` choisit la classe selon `provider` ;
  `llm/index.ts` n'exporte pas la classe, donc
  `grep -rl '@anthropic-ai/sdk' apps/api/src` ne trouve que `anthropic.ts`.

> **À retenir**
> Une interface décrit le besoin, une classe l'implémente avec le SDK, une
> fabrique choisit la classe. Le reste du code ne voit que l'interface.

**Questions**
1. Si tu voulais écrire un `FakeLlmClient` qui renvoie toujours « Bonjour »
   pour tester sans clé API, que devrait-il implémenter ?

---

## Leçon 3 : le streaming et Server-Sent Events

Sans streaming, l'utilisateur regarde un écran vide jusqu'à la fin de la
génération. Avec, il voit les premiers mots tout de suite et peut arrêter
une réponse mal partie. Reste à envoyer « un peu, puis un peu » sur une
seule réponse HTTP : c'est ce que fournit le format SSE.

```
event: delta
data: {"text":"Un monorepo"}

event: delta
data: {"text":" est un dépôt"}

event: done
data: {}

```

- Le streaming est une contrainte de **toute la chaîne** : modèle → Fastify
  → navigateur → `setState`. Si un maillon accumule, le bénéfice est perdu.
- SSE n'est qu'un format texte sur une réponse HTTP ordinaire
  (`Content-Type: text/event-stream`) : lignes `event:` / `data:`, puis une
  ligne vide comme séparateur.
- Trois événements : `delta` (`{ text }`), `done` (`{}`), `error`
  (`{ message }`).
- `data` est en JSON pour que les sauts de ligne du texte ne cassent pas le
  format. `flushHeaders()` envoie les en-têtes tout de suite, et
  `X-Accel-Buffering: no` empêche les proxys de mettre en tampon.
- `npm run hello` montre le premier maillon seul, dans le terminal.

> **À retenir**
> Chaque étape transmet immédiatement. Un événement SSE = `event:` +
> `data:` + une ligne vide.

**Questions**
1. Si `streamChat` renvoyait une `Promise<string>`, que faudrait-il changer
   dans la route `/chat` et dans le navigateur ?
2. Une fois les en-têtes envoyés avec le statut 200, peut-on encore
   répondre 404 ou 500 ? Que fait-on à la place ?

---

## Leçon 4 : le serveur reçoit un message

Notre message arrive en `POST /api/chat` avec
`{ "messages": [{ "role": "user", "content": "Explique les monorepos" }] }`.
Il faut le valider, ouvrir le flux, appeler le modèle et relayer chaque
fragment.

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

- **Valider d'abord** : Zod (`safeParse`) vérifie 1 à 50 messages, rôles
  `user`/`assistant` seulement, contenu non vide de 8 000 caractères max,
  dernier message `user`. Invalide : **400 en JSON**, le flux n'est pas
  encore ouvert.
- Puis `reply.raw.once("close", () => controller.abort())` : si le
  navigateur part, le modèle s'arrête. `reply.hijack()` dit à Fastify de ne
  plus toucher à la réponse.
- Le **prompt système** est ajouté côté serveur ; le client ne peut ni le
  voir ni le remplacer (le schéma refuse le rôle `system`).
- En cas d'échec, le détail va dans le log serveur, le client reçoit un
  message générique. Le serveur ne stocke rien et ne logue pas le contenu.

> **À retenir**
> Valider (400 JSON) → lier l'annulation à la fermeture de la connexion →
> prendre la main → relayer chaque fragment → `done` ou `error` → fermer.

**Questions**
1. Si tu déplaçais la validation Zod après `openSseStream`, que recevrait le
   navigateur en cas de corps invalide ?
2. Pourquoi envoie-t-on un message d'erreur générique au client alors qu'on
   connaît la vraie cause ?

---

## Leçon 5 : le navigateur lit le flux

`EventSource` ne fait que des `GET` sans corps ; nous devons envoyer
l'historique en `POST`. On utilise donc `fetch` et on lit le corps nous-mêmes,
puis on transforme chaque fragment en état React.

```ts
setMessages((prev) => appendToLastAssistant(prev, text));
```

- `fetch` se résout dès les en-têtes reçus ; `response.body` se lit ensuite
  morceau par morceau. Un statut non 2xx lève une erreur lisible.
- Trois couches : `reader.read()` (octets) → `TextDecoder` avec
  `{ stream: true }` (texte, sans casser un caractère coupé) → parseur SSE
  avec un `buffer` qui garde l'événement incomplet jusqu'au `\n\n` suivant.
- `run` ajoute d'abord une bulle assistant vide, passe en `"streaming"`,
  puis l'allonge à chaque delta.
- La **forme fonctionnelle** `prev => ...` part toujours de l'état le plus
  récent ; `appendToLastAssistant` recrée le tableau au lieu de le modifier.
- L'historique vit uniquement dans `messages` : recharger la page repart de
  zéro, c'est voulu.

> **À retenir**
> Chaque couche recolle un type de découpage : réseau, caractères,
> événements, rendus. Quand le nouvel état dépend de l'ancien, forme
> fonctionnelle.

**Questions**
1. Remplace mentalement `setMessages((prev) => ...)` par
   `setMessages([...messages, ...])`. Décris ce que l'utilisateur verrait.
2. Pourquoi le `TextDecoder` a-t-il besoin de l'option `{ stream: true }` ?

---

## Leçon 6 : afficher une réponse qui se construit

`Chat.tsx` appelle `useChat()` et passe des props aux composants
d'affichage. Il reste à rendre la réponse en Markdown, sans risque, et à
suivre le texte qui s'allonge.

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ block: "end" });
}, [messages]);
```

- `Composer` : Entrée envoie, Maj+Entrée insère un saut de ligne ; le
  bouton devient Stop pendant la génération.
- La réponse est rendue par `react-markdown`, qui **n'interprète pas le
  HTML** (pas de `rehype-raw`). Le texte utilisateur est affiché tel quel.
- Un curseur CSS clignote sur le dernier message tant que `streaming` est
  vrai.
- Le défilement ne dépend que de `messages` : jamais de fonction (`send`,
  `stop`, `t`…) dans les dépendances.

> **À retenir**
> Un composant porte l'état, les autres affichent. Markdown sans HTML brut,
> effet de défilement qui ne dépend que des données.

**Questions**
1. Que se passerait-il si `useEffect` dépendait de `[messages, send]` ?

---

## Leçon 7 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| Clic sur Stop | `abortRef.current?.abort()` rejette le `fetch` ; `run` repasse en `idle` en gardant le texte reçu (une bulle encore vide est retirée). La connexion se ferme, le `close` serveur coupe le modèle, le log dit « client déconnecté ». |
| Corps refusé (400) | `describeHttpError` affiche « Requête refusée : » suivi du premier message Zod ; `status = "error"`. |
| API arrêtée | Vite répond 500 : « Erreur du serveur (HTTP 500) ». |
| Erreur après ouverture du flux | Le statut 200 est parti : le serveur envoie `event: error`, le navigateur lève une `ChatError`, même bandeau. |
| Coupure réseau en plein flux | Ni `done` ni `error` : `completed === false`, d'où « La connexion s'est interrompue avant la fin de la réponse. » |
| Réessayer | `trimToLastUserMessage` retire la réponse incomplète et relance `run`, sans rien retaper. |

Le hook a trois états : `idle` → `streaming` (envoi ou Réessayer) →
`idle` (`done` ou Stop) ou `error` (puis Réessayer).

> **À retenir**
> Stop n'est pas une erreur. Les erreurs, avant ou pendant le flux, mènent
> toutes à `status = "error"` et au bouton Réessayer.

**Questions**
1. Pourquoi faut-il **deux** `AbortController`, et pas un seul partagé ?
2. Si tu retirais `setMessages(dropEmptyTrailingAssistant)` du `catch`,
   qu'afficherait l'interface après un Stop immédiat ?

---

## Leçon 8 : synthèse

### Les idées à emporter

1. **Le navigateur ne parle jamais au modèle.** La clé vit sur le serveur.
2. **Une interface isole le fournisseur.** Un seul fichier connaît le SDK.
3. **Le streaming est une contrainte de chaîne** : générateur, `res.write`,
   `reader.read`, `setState`.
4. **SSE = `event:`/`data:` + ligne vide**, avec un tampon pour les
   événements coupés.
5. **Valider avant de streamer** : le 400 n'est possible qu'avant les en-têtes.
6. **Deux `AbortController`**, reliés par la fermeture de la connexion.

### Vérifications manuelles

```bash
npm run dev          # api :3000 + web :5173
npm run typecheck    # TypeScript strict sur les deux apps
npm run hello        # la réponse s'écrit dans le terminal

# Flux SSE brut : des event: delta, puis event: done
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Dis bonjour."}]}'

# Un 400 en JSON : le dernier message doit être "user"
curl -i -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"assistant","content":"x"}]}'
```

Coupe le premier `curl -N` avec Ctrl+C après un delta : le log de l'API
affiche « client déconnecté, génération annulée ».

### Pour aller plus loin (non fait, volontairement)

Tronquer ou résumer un historique au-delà de 50 messages ; servir le build
derrière un reverse proxy sans tampon pour `text/event-stream` ; tester avec
un faux `LlmClient` et le parseur SSE sur des découpages arbitraires.

---

## Corrigé des questions

**L1.1** Vite injecte les variables `VITE_` en clair dans le bundle
JavaScript : chaque visiteur peut lire la clé et l'utiliser à tes frais
jusqu'à révocation.

**L2.1** Uniquement l'interface `LlmClient`, c'est-à-dire un
`async *streamChat()` qui `yield` quelques fragments ; un `case "fake"` dans
la fabrique suffit, le reste du code ne change pas.

**L3.1** Le serveur attendrait la réponse complète et l'enverrait en JSON,
le navigateur ferait un `response.json()` et Stop ne garderait plus de texte
partiel : le type de retour d'une méthode conditionne toute la chaîne.

**L3.2** Non, le statut est déjà parti (Node lève `ERR_HTTP_HEADERS_SENT`).
On envoie l'erreur dans le corps, sous forme d'un `event: error`, puis on
ferme.

**L4.1** Un `200 text/event-stream` puis un `error` ou une coupure, jamais
de 400 : le front n'afficherait pas le message Zod utile. Tout ce qui
produit un statut HTTP se décide avant `hijack()`.

**L4.2** La vraie cause peut révéler des détails internes (URL, modèle,
configuration) et l'utilisateur ne peut rien en faire ; elle va dans le log
serveur. Seul le 400 donne la cause, car elle concerne le client.

**L5.1** `run` capture une valeur figée de `messages` : chaque delta
repartirait de cet ancien tableau et écraserait le précédent, la réponse ne
s'accumulerait pas (fermeture périmée).

**L5.2** Le réseau coupe en octets et un caractère UTF-8 peut en faire
plusieurs : un « é » (`C3 A9`) coupé en deux donnerait « �� » sans cette
option, qui garde les octets incomplets.

**L6.1** Ici, quelques défilements en trop seulement, mais c'est un piège :
une fonction recréée à chaque rendu relancerait l'effet à chaque rendu. On
ne met en dépendance que les données dont l'effet dépend.

**L7.1** Un `AbortController` vit dans un seul processus. Le navigateur
coupe son `fetch`, ce qui ferme la connexion ; le serveur reçoit `close` et
coupe le modèle, pour toute fermeture, pas seulement Stop.

**L7.2** Une bulle assistant vide resterait, et le prochain envoi serait
refusé par Zod (« Le contenu est vide ») avec un 400 incompréhensible.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-1-flux-dun-message.md).
