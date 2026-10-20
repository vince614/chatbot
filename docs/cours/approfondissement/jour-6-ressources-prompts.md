# Jour 6 · Cours 2 — Ressources et prompts MCP : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-6-ressources-prompts.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Trois étages :
- le **serveur MCP** déclare des ressources et des prompts (`apps/mcp-server/src/resources/`, `prompts/`) ;
- l'**API** les liste pour l'interface et les résout dans `/chat` (`routes/mcp.ts`, `chat/mcp-context.ts`) ;
- le **navigateur** les présente (`apps/web/src/mcp/`) et ne transmet que des références.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `packages/rag/src/db/repository.ts` | `readVisibleDocument` : les passages d'un document, si les groupes le permettent | 2 |
| `apps/mcp-server/src/resources/documents.ts` | catalogue, modèle `rag://documents/{fichier}`, `readDocumentText`, `completeFileName`, `timed` | 2 |
| `apps/mcp-server/src/prompts/documents.ts` | les trois prompts, `completable`, ressource embarquée | 3 |
| `apps/mcp-server/src/server.ts` | enregistre outils, ressources et prompts | 1 |
| `apps/api/src/mcp/pool.ts` | `listResources`, `readResource`, `listPrompts`, `getPrompt`, `completePromptArgument` | 4 |
| `apps/api/src/routes/mcp.ts` | `GET /api/mcp/resources`, `GET /api/mcp/prompts`, `POST /api/mcp/complete` | 4 |
| `apps/api/src/chat/mcp-context.ts` | schémas des références, `expandMessages`, `<pieces_jointes>`, erreurs 400/503 | 4, 5 |
| `apps/api/src/routes/chat.ts` | accepte `attachments` et `prompt`, résout avant d'ouvrir le flux | 4 |
| `apps/api/src/rag/prompt.ts` | règle `ATTACHMENTS` dans les deux prompts système | 5 |
| `apps/web/src/mcp/api.ts`, `useMcpCatalog.ts` | appels aux routes, chargement par utilisateur | 4 |
| `apps/web/src/mcp/PromptMenu.tsx`, `PromptForm.tsx` | menu « / », formulaire, autocomplétion | 3 |
| `apps/web/src/mcp/AttachmentPicker.tsx`, `AttachmentChips.tsx` | bouton 📎, pastilles | 2 |
| `apps/web/src/chat/Composer.tsx`, `useChat.ts`, `types.ts` | envoi `{ text, attachments?, prompt? }`, `toWireHistory` | 4 |
| `apps/web/src/storage/types.ts`, `conversations.ts` | l'historique chiffré garde les références | 4 |

## Le parcours dans le code

chloe tape `/resu`, choisit le prompt, tape `reg`, choisit `reglement-interieur.pdf` et envoie.

1. Au choix de l'utilisateur, **`useMcpCatalog("chloe")`** appelle `GET /api/mcp/prompts` et `GET /api/mcp/resources`
   → `routes/mcp.ts` → `pool.listPrompts` / `listResources` → `prompts/list`, `resources/list` côté serveur.
2. `/` dans le textarea → `Composer` ouvre **`PromptMenu`** (filtré sur `resu`) → Entrée → **`PromptForm`**.
3. `reg` dans le champ → 200 ms plus tard, `completeArgument` → `POST /api/mcp/complete` →
   `pool.completePromptArgument` → `completion/complete` → le `completable` du serveur → **`completeFileName`**.
4. Envoi → `submitPrompt` → `send({ text: "/resumer_document · fichier = …", prompt })` → `run` →
   **`toWireHistory`** → `POST /api/chat`.
5. `routes/chat.ts` : identité, schéma (dont `promptRefSchema`), puis **`expandMessages`** →
   `pool.getPrompt` → `prompts/get` côté serveur → `readDocumentText` → `readVisibleDocument`.
6. Les messages du prompt deviennent du texte : la ressource embarquée devient `<pieces_jointes>` + rappel, la consigne suit.
7. `runConversation`, comme d'habitude. La réponse cite `(reglement-interieur.pdf, p. 3–4)`.
8. `saveConversation` → `toStoredMessages` garde `prompt` : rouvrir la conversation et poser une question de
   suite renvoie le même prompt, résolu à nouveau.

---

## `packages/rag/src/db/repository.ts` — `readVisibleDocument`

```ts
`SELECT c.chunk_index, c.page_start, c.page_end, c.content
 FROM documents d JOIN chunks c ON c.document_id = d.id
 WHERE d.file_name = $1 AND d.allowed_groups && $2::text[]
 ORDER BY c.chunk_index`
```

**Ce que fait le code** : renvoie les passages du document, dans l'ordre, **seulement** si l'un des groupes
de l'utilisateur est autorisé. Zéro ligne → `null`.

**Pourquoi** : le filtre est dans le `WHERE`, comme pour la recherche (jour 3). « Interdit » et « inexistant »
donnent tous deux zéro ligne : l'appelant ne peut pas les distinguer, et ne peut donc rien en révéler.

## `apps/mcp-server/src/resources/documents.ts`

### `registerDocumentResources`

```ts
new ResourceTemplate(DOCUMENT_TEMPLATE, {
  list: async () => {
    const docs = await listVisibleDocuments(pool, user.groupes);
    return { resources: docs.map((doc) => ({ uri: documentUri(doc.fileName), name: doc.fileName, … })) };
  },
  complete: { fichier: (value) => completeFileName(context, value) },
}),
```

**Ce que fait le code**
1. Déclare le catalogue (`rag://documents`, Markdown) comme ressource **fixe**.
2. Déclare le modèle `rag://documents/{fichier}`. Le SDK s'en sert pour router `resources/read` et extraire `fichier`.
3. `list` alimente `resources/list` ; `complete` alimente `completion/complete` sur ce modèle.
4. À la lecture, `decodeVariable` décode l'URI (`r%C3%A8glement.pdf`) et `readDocumentText` fait le reste.

**Pourquoi**
- Le SDK **ne décode pas** les variables d'URI. D'où `encodeURIComponent` à l'écriture (`documentUri`) et
  `decodeURIComponent` à la lecture.
- `user` vient du contexte de la session, comme pour les outils : aucune variable d'URI ne peut le changer.

### `readDocumentText` et `joinPassages`

```ts
const content = passage.content.slice(overlap(previous, passage.content));
// …
for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
  if (previous.endsWith(next.slice(0, length))) return length;
}
```

**Ce que fait le code** : pour chaque passage, retire le plus long début qui termine déjà le passage
précédent, puis préfixe les pages (`[p. 3–4]`). Au-delà de 40 000 caractères, le texte est coupé, avec une mention.

**Pourquoi** : le découpage du jour 2 fait se chevaucher les passages de 15 %. Sans ce nettoyage, le modèle lirait
des phrases en double, et les payerait.

### `timed`

**Ce que fait le code** : une ligne de log par lecture (`ressource document : ok en 2 ms (utilisateur chloe)`).
Une `McpError` (« introuvable ») repart telle quelle ; toute autre erreur (pg) devient
`InternalError « Lecture impossible »`, et son détail reste dans le log.

**Pourquoi** : sans cela, le SDK renverrait au client le message brut de Postgres, avec le nom des tables.

## `apps/mcp-server/src/prompts/documents.ts`

```ts
const fileArgument = (description: string) =>
  completable(z.string().min(1).describe(description), (value) => completeFileName(context, value ?? ""));
// …
async function embed(context: ToolContext, fileName: string): Promise<PromptMessage> {
  const text = await readDocumentText(context, fileName);
  return { role: "user", content: { type: "resource", resource: { uri: documentUri(fileName), mimeType: "text/plain", text } } };
}
```

**Ce que fait le code**
1. `fileArgument` : un argument texte qui sait se compléter parmi les documents visibles.
2. `resumer_document` → `[embed(fichier), say(consigne)]`. `comparer_documents` → deux `embed` et une consigne en tableau. `question_sourcee` → une consigne seule.
3. Chaque prompt passe par `timed` (log, erreurs neutres).

**Pourquoi**
- `completable` enveloppe le schéma zod : la validation reste celle de zod, l'autocomplétion vient en plus.
- La consigne est écrite **côté serveur** : améliorer le résumé ne demande de toucher ni à l'API, ni au navigateur.

## `apps/api/src/routes/mcp.ts`

**Ce que fait le code** : trois routes qui identifient l'utilisateur (`X-User-Id`, 401 sinon), puis appellent le
pool. Elles ne renvoient que les champs utiles à l'affichage. Toute erreur MCP ou OAuth devient un **503**.

**Pourquoi** : aucune route ne renvoie le **contenu** d'une ressource. Le navigateur n'en a pas besoin : il ne
manipule que des URI. Moins il reçoit de texte de documents, moins il en garde (historique, extensions).

## `apps/api/src/chat/mcp-context.ts` — `expandMessages`

```ts
for (const message of messages) {
  if (message.role === "user" && message.prompt) {
    const result = await resolve(() => mcp.getPrompt(userId, message.prompt!.name, message.prompt!.arguments));
    for (const promptMessage of result.messages) push(expanded, promptMessage.role, promptText(promptMessage, budget));
  }
  if (message.role === "user" && message.attachments?.length) {
    const resources = await Promise.all(message.attachments.map((uri) => resolve(() => mcp.readResource(userId, uri))));
    push(expanded, "user", attachmentsBlock(resources, budget));
  }
  if (!(message.role === "user" && message.prompt)) push(expanded, message.role, message.content);
}
```

**Ce que fait le code**
1. Un message prompt est **remplacé** par les messages du prompt. Son libellé (`content`) n'est jamais envoyé au modèle.
2. Les pièces jointes sont lues en parallèle, puis mises en bloc **avant** le texte du message.
3. `push` fusionne deux messages consécutifs du même rôle : le fournisseur attend des tours alternés.
4. `budget` décompte les caractères ; au-delà de 120 000, `McpContextError(400)`.
5. `resolve` traduit les erreurs : `InvalidParams` (introuvable, prompt inconnu) → 400 avec le message du
   serveur, sans le préfixe `MCP error -32602:` que le SDK ajoute deux fois ; tout le reste → 503.
6. `strict` n'est vrai que pour le dernier message. Ailleurs, une référence refusée donne `null`, puis une
   mention `[pièce(s) jointe(s) indisponible(s) : …]` ou `[prompt … indisponible : …]`.

**Pourquoi**
- `strict` corrige un bug réel des premiers essais. bruno lance `/comparer_documents` avec `rh.pdf` : 400,
  normal. Mais le message restait dans l'historique, et chaque message suivant était refusé à son tour
  sur le même `rh.pdf`. La conversation était bloquée. Deux corrections : côté API, l'historique est
  résolu sans être exigé ; côté navigateur, un message refusé en 400 est retiré (voir `useChat` plus bas).
- L'appel est fait **avant** `reply.hijack()` dans `routes/chat.ts` : une référence refusée reçoit un JSON
  `{ error }` ordinaire, que `describeHttpError` affiche dans la bannière d'erreur.
- En mode `RAG_MODE=always`, la recherche part du **texte saisi** (`parsed.data.messages.at(-1).content`),
  pas des pièces jointes : on ne cherche pas avec 40 000 caractères.

### `attachmentsBlock` et `neutralizeTags`

```ts
return [`<piece_jointe uri="${content.uri.replace(/"/g, "'")}">\n${neutralizeTags(content.text)}\n</piece_jointe>`];
// …
text.replace(/<(\/?)(pieces?_jointes?)(?=[\s>])/gi, "‹$1$2");
```

**Pourquoi** : un document qui contiendrait `</piece_jointe>` pourrait sinon fermer notre balise, et faire passer
la suite pour un message de l'utilisateur. C'est la même parade que `neutralizeTags` des extraits (jour 5).

## Le navigateur

### `useMcpCatalog`

```ts
useEffect(() => {
  // …
  const controller = new AbortController();
  fetchResources(userId, controller.signal).then(…).catch(…);
  fetchPrompts(userId, controller.signal).then(…).catch(…);
  return () => controller.abort();
}, [userId]);
```

**Ce que fait le code** : à chaque changement d'utilisateur, recharge les deux listes, chacune avec son état
(`loading`, `ready`, `unavailable`). Le changement suivant annule les requêtes en cours.

**Pourquoi** : la liste de bruno ne doit jamais s'afficher sous le nom de chloe, même une fraction de seconde
(d'où la remise à `EMPTY`). Les deux listes sont indépendantes : un 503 sur l'une n'affecte pas l'autre.

### `Composer`, `PromptForm`, `AttachmentPicker`

- `Composer` garde le brouillon, les pièces jointes (3 au plus) et le prompt choisi. Il reçoit
  `key={userId}` depuis `Chat.tsx` : changer d'utilisateur repart d'un composer vierge, sans pastille d'un autre.
- `PromptForm` : un champ par argument, une combobox ARIA, et une requête d'autocomplétion 200 ms après
  la dernière frappe (annulée à la frappe suivante). Les arguments déjà remplis partent dans `arguments`.
- `submitPrompt` construit le libellé `/nom · arg = valeur` : c'est le `content` envoyé, le texte de la
  bulle et la base du titre de la conversation.

### Un refus (400) dans `useChat`

```ts
const refused = err instanceof ChatError && err.status === 400;
if (refused) commit(dropTrailingUserMessage);
setCanRetry(!refused);
```

**Ce que fait le code** : `ChatError` porte désormais le statut HTTP. Un 400 veut dire que la requête n'a pas été
traitée : le message de l'utilisateur sort de l'historique, et `ErrorBanner` n'affiche pas « Réessayer »
(`onRetry` absent), puisque la même requête serait refusée de la même façon.

### `toWireHistory` et le stockage

```ts
return messages.map(({ role, content, attachments, prompt }) => ({
  role, content,
  ...(attachments?.length && { attachments: attachments.map((attachment) => attachment.uri) }),
  ...(prompt && { prompt }),
}));
```

**Pourquoi** : l'API résout tout l'historique à chaque requête. Un message qui perdrait ses références en
route ferait « oublier » au modèle le document d'un tour précédent. `StoredMessage` garde les mêmes champs,
pour qu'une conversation rouverte se comporte de la même façon.

---

## Pour explorer toi-même

- **L'Inspector en stdio** : `npx @modelcontextprotocol/inspector npm run --silent mcp` (avec
  `MCP_USER_ID=bruno` dans l'environnement). Onglet *Resources* : lis `rag://documents/reglement-interieur.pdf`
  et observe l'erreur. Onglet *Prompts* : l'autocomplétion de `fichier`.
- **Voir ce que reçoit le modèle** : `CHAT_DEBUG=true`, puis joins un document. Dans le journal, ouvre
  `modèle → envoyé au modèle` et cherche `<pieces_jointes>` et `Fin des pièces jointes`.
- **Une injection dans un document joint** : `security/attacks/01-injection/piege.pdf` (jour 5). Ingère-le
  pour chloe, joins-le, et compare la réponse avec et sans `ATTACHMENT_REMINDER`.
- **Le coût d'une pièce jointe** : avec le panneau debug, pose trois questions de suite sur un document joint
  et observe la taille de `POST /api/chat` dans le journal (`… octets`). Elle reste petite (des références),
  alors que le message envoyé au modèle, lui, grossit.
- **Un quatrième prompt** : ajoute `lister_obligations(fichier)` dans `prompts/documents.ts`. Il apparaît dans
  le menu `/` sans toucher au front.
