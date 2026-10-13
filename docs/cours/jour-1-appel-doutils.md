# Jour 1 · Cours 2 — Donner des outils à un chatbot (tool use)

> [Sommaire](README.md) · Précédent : [Jour 1 · Cours 1 — Le flux d'un message](jour-1-flux-dun-message.md) · Suivant : [Jour 2 · Cours 1 — L'ingestion d'un RAG](jour-2-ingestion.md)

> **Prérequis.** Avoir suivi [le flux d'un message](jour-1-flux-dun-message.md) :
> un chatbot en streaming `useChat` → `POST /api/chat` → `LlmClient.streamChat`
> → Anthropic, avec des événements SSE `delta`, `done` et `error`. Ce cours
> ajoute une seule capacité : le modèle peut **demander l'exécution de
> fonctions** que nous écrivons.
>
> **Le fil rouge.** « Quel jour serons-nous dans 45 jours ? » Le modèle ne
> connaît pas la date du jour : il doit appeler un outil pour répondre
> « jeudi 26 novembre 2026 ».

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'est-ce que le tool use, et qu'avons-nous construit ? |
| 1 | Comment décrire une conversation avec outils sans dépendre d'un fournisseur, et reconstituer un appel streamé ? |
| 2 | Comment écrire un outil que le modèle saura utiliser ? |
| 3 | Comment exécuter un outil sans jamais faire échouer la requête ? |
| 4 | La boucle : que fait le serveur entre deux appels au modèle ? |
| 5 | Comment le navigateur affiche-t-il les appels sans les mémoriser ? |
| 6 | Quand ça se passe mal |
| 7 | Synthèse |

---

## Leçon 0 : vue d'ensemble

**L'idée en une phrase.** On décrit des fonctions au modèle, il *demande*
qu'on en appelle une, notre serveur l'exécute et lui renvoie le résultat
pour qu'il continue.

Trois points qui déterminent tout le code :

- **Le modèle n'exécute rien.** Il émet un bloc structuré « appelle
  `calculate` avec `{"expression": "1234 * 5678"}` » ; c'est le serveur qui
  exécute, s'il le veut bien.
- **C'est une boucle.** Après l'exécution, il faut rappeler le modèle avec le
  résultat. Une boucle a besoin d'une condition d'arrêt.
- **Le modèle choisit seul.** « Bonjour » n'appelle aucun outil, « quel jour
  dans 45 jours ? » appelle la date. La description de l'outil fait partie du
  programme.

**Ce que nous avons ajouté.**

- `apps/api/src/llm/` : format neutre (`types.ts`) et traduction Anthropic
  (`anthropic.ts`).
- `apps/api/src/tools/` (nouveau, ne connaît ni le LLM ni Fastify) :
  `get_current_datetime`, `calculate` et le registre.
- `apps/api/src/routes/chat.ts` : la boucle ; `sse.ts` : deux événements de
  plus, `tool_call` et `tool_result`.
- `apps/web/src/chat/` : `useChat.ts`, `api.ts`, `types.ts` et le nouveau
  composant `ToolActivityLine.tsx`.

> **À retenir**
> Décrire → le modèle demande → nous exécutons → nous renvoyons le résultat →
> le modèle conclut. Le modèle n'exécute jamais rien lui-même.

**Questions**

- **L0.1** Qu'est-ce qui empêche un utilisateur malveillant de faire exécuter
  n'importe quoi au serveur via un appel d'outil ?

---

## Leçon 1 : un format neutre, traduit et reconstitué

Avec les outils, un message assistant peut contenir du texte *et* des
demandes d'appel, et un message utilisateur des résultats d'outils. Chaque
fournisseur l'écrit à sa façon. Comme pour `LlmClient`, nous définissons
**notre** format, et seul `anthropic.ts` sait le traduire.

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

- Le `tool_call` porte un `id`, que le `tool_result` reprend dans
  `toolCallId` ; `input` est `unknown`, le registre le validera.
- `streamChat` ne rend plus des `string` mais des **événements** : `text`, ou
  `tool_call` complet, arguments déjà parsés.
- La traduction vers Anthropic est un `switch` exhaustif (`tool_call` →
  `tool_use`) : un nouveau type de morceau ne compilerait pas sans elle.
- En streaming, un appel arrive en morceaux : `content_block_start`
  (identité), `input_json_delta` × n (fragments de JSON), `content_block_stop`.
  On garde un tampon par `index` de bloc et on ne parse qu'au `stop`, comme
  le parseur SSE du cours précédent.
- Un outil sans argument n'émet aucun delta : le tampon vide donne `{}`, car
  `JSON.parse("")` aurait levé.

> **À retenir**
> Des messages faits de morceaux `text`, `tool_call` (avec id) et
> `tool_result` (avec le même id), traduits par un seul fichier. Un appel
> streamé se reconstitue avec un tampon par bloc.

**Questions**

- **L1.1** Pourquoi `tool_call` a-t-il besoin d'un `id` alors que le nom de
  l'outil suffirait dans la plupart des cas ?
- **L1.2** Qu'arriverait-il si on faisait `JSON.parse` à chaque
  `input_json_delta` au lieu d'attendre `content_block_stop` ?

---

## Leçon 2 : écrire un outil que le modèle saura utiliser

Un outil, c'est un `name` et une `description` (pour le modèle), un `schema`
Zod (converti en JSON Schema pour le modèle, et qui valide ce qu'il produit)
et une fonction `execute` typée d'après ce schéma. Le modèle ne voit que le
nom, la description et le schéma : leur rédaction pilote son comportement.

```ts
description:
  "Donne la date et l'heure actuelles. À utiliser pour toute question qui dépend " +
  "d'aujourd'hui (quel jour sommes-nous, dans combien de jours, quelle heure est-il…) " +
  "plutôt que de deviner.",
```

- La description dit *ce que fait* l'outil, *quand* l'utiliser (avec des
  formulations) et *quoi ne pas faire* (« plutôt que de deviner »).
- Le `.describe()` des champs Zod joue le même rôle par argument : grâce à
  « Fuseau horaire IANA, par exemple "Europe/Paris" », le modèle a envoyé
  `"Europe/Paris"` sans qu'on le lui demande.
- `get_current_datetime` renvoie plusieurs représentations (ISO, date en
  français, jour de la semaine, timestamp) ; un fuseau inconnu devient un
  message clair à nous, que le modèle reformulera.
- `calculate` n'utilise **jamais `eval`** : la chaîne vient du modèle, donc
  de l'utilisateur. Un petit évaluateur par descente récursive ne connaît
  que les nombres et sept opérateurs.
- Ses erreurs sont localisées (« Expression invalide à la position 5 :
  nombre attendu. ») : un message précis est une donnée que le modèle
  exploite pour expliquer l'erreur.

> **À retenir**
> Nom, description écrite pour le modèle, schéma Zod qui décrit et valide,
> fonction typée. Jamais d'`eval` sur une entrée venue du modèle.

**Questions**

- **L2.1** Le modèle a envoyé `"Europe/Paris"` sans qu'on le lui demande.
  D'où tient-il cette idée ?

---

## Leçon 3 : le registre ne fait jamais échouer la requête

Un outil qui échoue n'est pas une panne du serveur : c'est une information
pour le modèle (« ce fuseau n'existe pas »). Si l'exception remontait à la
route, l'utilisateur verrait « La génération a échoué » sans savoir que son
expression était fausse. Le registre transforme donc tout échec en résultat.

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

- Quatre échecs deviennent `{ ok: false, content }` : outil inconnu,
  arguments refusés par Zod, délai dépassé, exception de l'outil.
- Seule la déconnexion du client relance : il n'y a plus personne à qui
  répondre.
- `AbortSignal.any` combine annulation et délai ; `Promise.race` abandonne
  même un outil qui ignorerait son signal.
- Le JSON Schema est généré depuis Zod (`z.toJSONSchema`) : une seule
  source de vérité pour décrire et valider.

> **À retenir**
> Tout échec d'outil devient un résultat lisible par le modèle, sauf la
> déconnexion du client.

**Questions**

- **L3.1** Pourquoi la déconnexion du client est-elle le seul cas où
  `execute` relance une exception ?

---

## Leçon 4 : la boucle

La validation, le `hijack`, l'annulation et le `finally` de la route ne
changent pas. Ce qui change : entre l'ouverture du flux et le `done`, il n'y
a plus un appel au modèle mais une boucle de tours, `runConversation`.

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

- Un tour = un appel au modèle. Le texte part en SSE immédiatement ; les
  `tool_call` sont collectés jusqu'à la fin du tour.
- Pas d'appel d'outil : le modèle a conclu, la route envoie `done`.
- Sinon, on ajoute **deux messages** à `history` : l'assistant (son texte
  éventuel, puis ses appels) et un `user` avec les résultats. Les appels
  d'un même tour s'exécutent en parallèle (`Promise.all`).
- Chaque appel émet `tool_call` (nom, arguments) puis `tool_result` (nom,
  `ok`) vers le navigateur ; le contenu complet ne va qu'au modèle, et le
  log ne garde que nom, durée et `ok`.
- `MAX_TOOL_TURNS = 5` : au-delà, `error` explicite « trop d'appels d'outils
  sans conclure », log en `warn`.

> **À retenir**
> Texte → SSE tout de suite. Appels → exécution, puis assistant + résultats
> ajoutés à l'historique, et on repart. Pas d'appel = fin. Cinq tours
> maximum.

**Questions**

- **L4.1** Pourquoi faut-il accumuler `text` dans une variable alors qu'on
  l'a déjà envoyé au navigateur ?

---

## Leçon 5 : le navigateur affiche sans mémoriser

Le navigateur reçoit `tool_call` et `tool_result` et les affiche dans la
bulle en cours (`UiMessage` = message + `tools` pour l'affichage). Mais que
renvoyer au serveur au message suivant ? Nous avons choisi du texte seul.

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

- `ToolActivity.ok` encode trois états : indéfini (en cours), `true`,
  `false`. `ToolActivityLine` affiche un point qui clignote, vert ou rouge.
- Le parseur SSE n'a pas changé d'une ligne : seul le `switch` de
  `streamChat` gagne deux `case`.
- `tool_result` ne porte que le nom : on marque le premier appel de ce nom
  encore en cours, approximation suffisante pour un affichage.
- Conséquence observée : à « et ce résultat en secondes ? », le modèle a
  rappelé `get_current_datetime`.

> **À retenir**
> Les activités d'outils ne quittent jamais le navigateur ; l'historique
> envoyé reste du texte. Simplification assumée et documentée dans le code.

**Questions**

- **L5.1** Quel est l'avantage de sécurité de ne jamais accepter de
  `tool_result` venant du client ?

---

## Leçon 6 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| Expression invalide (`12 ++* 7`) | `calculate` lève, le registre rend `ok: false`. Ligne rouge « échec », le modèle explique l'erreur, la requête finit par `done`. |
| Fuseau inconnu | Même chemin, message « Fuseau horaire inconnu ». |
| Arguments hors schéma | Zod refuse avant l'exécution ; le modèle corrige en général au tour suivant. |
| Outil trop lent | `AbortSignal.timeout` l'abandonne, le modèle reçoit « a dépassé le délai de 5000 ms ». Pas d'erreur de requête. |
| Le modèle boucle | Après cinq tours, `error` explicite, bandeau et Réessayer ; les deltas reçus restent affichés. |
| Stop pendant un outil | Le signal combiné se déclenche, le registre relance, la route logue « client déconnecté, génération annulée ». La dernière ligne reste « en cours ». |
| Vraie panne (clé invalide, API injoignable) | Chemin du cours précédent : `error` générique, log `error` avec la cause. |

> **À retenir**
> Un échec d'outil est une donnée pour le modèle, pas une erreur de requête.
> Seuls le plafond de tours et une vraie panne produisent un `error`.

**Questions**

- **L6.1** Pourquoi le plafond de tours produit-il un message spécifique
  alors que la panne produit un message générique ?

---

## Leçon 7 : synthèse

### Les idées à emporter

1. **Le modèle demande, le serveur exécute**, et seulement les outils déclarés.
2. **Un format neutre, un traducteur** : seul `anthropic.ts` connaît `tool_use`.
3. **Reconstituer en streaming** : un tampon par index, émission au `stop`.
4. **Un échec d'outil est un résultat** : le registre ne lève jamais, sauf déconnexion.
5. **La boucle a un plafond** : cinq tours, puis un `error` explicite.
6. **Le client ne porte que du texte** : les outils vivent le temps d'une requête.

### Vérifications manuelles

Lance `npm run dev`, ouvre `http://localhost:5173`.

| Message | Ce qu'on doit voir |
| --- | --- |
| « Quel jour serons-nous dans 45 jours ? » | ligne `get_current_datetime` verte, puis la date en texte |
| « Combien font 1234 × 5678 ? » | ligne `calculate {"expression":"1234 * 5678"}` verte, puis « 7 006 652 » |
| « Bonjour » | aucune ligne d'outil, réponse directe |
| « Calcule avec l'outil, sans la corriger, exactement : 12 ++* 7 » | ligne `calculate` rouge « échec », puis une explication |
| Stop pendant une génération | la bulle garde texte et lignes ; log `client déconnecté, génération annulée` |

### Pour aller plus loin (non fait, volontairement)

Faire transiter l'`id` des appels dans le SSE, garder les résultats d'outils
dans l'historique client, des outils à effet de bord (avec confirmation),
des outils distants via MCP.

---

## Corrigé des questions

**L0.1** Le modèle ne peut demander que les outils que nous déclarons, leurs
arguments sont validés par Zod, et nos outils ne font rien de dangereux
(`calculate` n'interprète qu'une grammaire arithmétique, pas du JavaScript).

**L1.1** Le modèle peut appeler le même outil plusieurs fois dans un tour :
le nom ne suffit plus à apparier chaque résultat, et le fournisseur exige
qu'on renvoie l'`id` dans le `tool_result`.

**L1.2** Chaque fragment n'est qu'un morceau de JSON (`{"expr` n'est pas
parsable) : on aurait une exception dès le premier delta.

**L2.1** De la description du champ (« par exemple "Europe/Paris" »), de la
langue de l'utilisateur et du prompt système. Ce n'est qu'une inférence,
fausse pour un francophone à Montréal.

**L3.1** Un échec d'outil est une information pour le modèle ; une
déconnexion signifie qu'il n'y a plus personne à qui répondre, et continuer
la boucle coûterait des tokens pour rien.

**L4.1** Si le tour demande des outils, il faut renvoyer au modèle son propre
message assistant, texte compris : le fournisseur exige ce message avant
les `tool_result`.

**L5.1** Un client qui enverrait des `tool_result` pourrait inventer des
résultats que le modèle croirait ; en n'acceptant que du texte, tout
résultat d'outil vient du serveur, dans cette requête.

**L6.1** Le message générique protège des fuites techniques ; le plafond est
une limite que nous avons choisie, et le dire aide l'utilisateur à
reformuler plutôt qu'à réessayer en boucle.
