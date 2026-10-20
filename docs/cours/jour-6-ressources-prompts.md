# Jour 6 · Cours 2 — Ressources et prompts MCP

> [Sommaire](README.md) · Précédent : [Jour 6 · Cours 1 — Le serveur MCP distant, protégé par OAuth](jour-6-oauth-mcp.md) · [Approfondissement : le code](approfondissement/jour-6-ressources-prompts.md)

> **Prérequis.** [Le cours précédent](jour-6-oauth-mcp.md) : le serveur MCP
> est distant, et chaque requête porte un jeton de l'utilisateur. Jusqu'ici,
> il n'exposait que des **outils** (`search_documents`, `list_documents`).
>
> **Le fil rouge.** chloe tape `/`, choisit « Résumer un document »,
> l'autocomplétion lui propose `reglement-interieur.pdf`, et elle obtient un
> résumé cité page par page. bruno, lui, ne voit même pas ce document.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Qui décide d'utiliser un outil, une ressource, un prompt ? |
| 2 | Qu'est-ce qu'une ressource, et un modèle d'URI ? |
| 3 | Qu'apporte un prompt fourni par le serveur ? |
| 4 | Pourquoi le navigateur n'envoie-t-il que des références ? |
| 5 | Une pièce jointe est-elle une donnée sûre ? |
| 6 | Quand ça se passe mal |
| 7 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Le serveur MCP expose maintenant les **trois primitives** du protocole.
L'interface s'en sert : le menu `/` pour les prompts, le bouton 📎 pour les
ressources.

```
apps/mcp-server/src/
  resources/documents.ts      rag://documents (catalogue) + rag://documents/{fichier}
  prompts/documents.ts        resumer_document, comparer_documents, question_sourcee
packages/rag/src/db/repository.ts   readVisibleDocument : le texte d'un document, filtré par les droits
apps/api/src/
  routes/mcp.ts               GET /api/mcp/resources, GET /api/mcp/prompts, POST /api/mcp/complete
  chat/mcp-context.ts         expandMessages : références → contenu, avant le modèle
  mcp/pool.ts                 listResources, readResource, listPrompts, getPrompt, completePromptArgument
apps/web/src/mcp/             menu « / », formulaire de prompt, autocomplétion, pastilles
```

---

## Leçon 1 : qui décide ?

| Primitive | Qui la déclenche | Chez nous |
| --- | --- | --- |
| **Outil** (tool) | le **modèle**, pendant sa réponse | `search_documents` |
| **Ressource** (resource) | l'**application** ou l'utilisateur | 📎 Joindre `reglement-interieur.pdf` |
| **Prompt** | l'**utilisateur**, explicitement | `/resumer_document` |

- La différence ne tient pas au contenu : les trois lisent les mêmes
  documents. Elle tient à **qui a le contrôle**.
- Un outil, c'est le modèle qui le choisit : sa description doit le
  convaincre (jour 4). Une ressource ou un prompt, c'est l'humain qui le
  choisit : il faut une **interface** pour les présenter.
- Conséquence pour la sécurité : le modèle ne peut pas décider seul de
  joindre un document entier ou de lancer un prompt. Ce n'est jamais lui qui
  déclenche ces actions.

> **À retenir**
> Outils = le modèle choisit. Ressources = l'application choisit. Prompts = l'utilisateur choisit.

**Question**
1. On veut que le modèle puisse lire un document entier quand il le juge utile. Faut-il une ressource ou un outil ?

---

## Leçon 2 : les ressources

```ts
server.registerResource(
  "document",
  new ResourceTemplate("rag://documents/{fichier}", {
    list: async () => { /* un élément par document VISIBLE */ },
    complete: { fichier: (value) => completeFileName(context, value) },
  }),
  { title: "Document", mimeType: "text/plain" },
  async (uri, variables) => { /* readDocumentText(context, fichier) */ },
);
```

- Une ressource est identifiée par une **URI**. `rag://documents` est une
  ressource fixe (le catalogue). `rag://documents/{fichier}` est un **modèle
  d'URI** (RFC 6570) : une ressource par document, sans les déclarer une à une.
- `list` fournit `resources/list` : observé, chloe voit 3 ressources et
  bruno 2. Le filtre par groupes est dans le SQL, comme pour la recherche.
- Lire `rag://documents/reglement-interieur.pdf` en tant que bruno donne
  **« Document introuvable »**, le même message que pour un fichier qui
  n'existe pas. Une URI devinée ne révèle rien.
- Le texte est reconstitué à partir des passages, avec leurs pages, en
  retirant le **chevauchement** de 15 % entre passages voisins (jour 2). Il est
  tronqué à 40 000 caractères.

> **À retenir**
> Une ressource se lit à la demande du client, avec les mêmes droits qu'un outil : le serveur filtre, le client ne peut pas demander mieux.

---

## Leçon 3 : les prompts

```ts
server.registerPrompt("resumer_document", {
  title: "Résumer un document",
  argsSchema: { fichier: completable(z.string().min(1), (value) => completeFileName(context, value)) },
}, ({ fichier }) => /* [ document embarqué, consigne ] */);
```

- Un prompt est un **modèle de demande** que le serveur fournit. Il connaît
  ses données : c'est lui qui sait formuler « résume en 5 points, avec la
  page de chaque point ».
- **`completable`** branche l'autocomplétion (`completion/complete`). Observé :
  `reg` donne `["reglement-interieur.pdf"]` pour chloe et `[]` pour bruno.
  L'autocomplétion respecte les droits elle aussi.
- Un prompt peut **embarquer une ressource** (`type: "resource"`). Le texte
  du document arrive dans le message, comme une pièce jointe. C'est pour
  cela que le résumé observé cite `(reglement-interieur.pdf, p. 3–4)` sans
  avoir appelé `search_documents`.
- `question_sourcee`, lui, n'embarque rien : il pousse le modèle à
  **chercher** puis à citer. Un prompt peut donc aussi orienter l'usage des outils.

> **À retenir**
> Un prompt MCP, c'est le savoir-faire du serveur, mis à la disposition de l'utilisateur.

**Question**
1. Pourquoi l'argument `fichier` est-il une chaîne libre plutôt qu'une liste fermée (enum) des documents ?

---

## Leçon 4 : des références, pas du contenu

Ce que le navigateur envoie à `/api/chat` pour le fil rouge :

```json
{ "role": "user", "content": "/resumer_document · fichier = reglement-interieur.pdf",
  "prompt": { "name": "resumer_document", "arguments": { "fichier": "reglement-interieur.pdf" } } }
```

- Le navigateur n'envoie **jamais** le texte d'un document : seulement l'URI
  d'une pièce jointe ou le nom d'un prompt et ses arguments. C'est
  `expandMessages` (côté API) qui les **résout**, en tant que l'utilisateur,
  avant d'appeler le modèle.
- Conséquence : le navigateur ne peut pas fabriquer un faux « document
  officiel ». bruno qui envoie à la main
  `attachments: ["rag://documents/reglement-interieur.pdf"]` reçoit
  `400 Document introuvable`, sans qu'aucun appel au modèle ne soit fait.
- Les références sont résolues **à chaque requête**, pour tout l'historique.
  Les droits sont donc revérifiés à chaque tour, et l'historique chiffré du
  navigateur ne garde que des références, pas de copie des documents.
- Seules les références du **dernier** message sont exigées. Une référence
  plus ancienne qui ne se résout plus devient une mention : sinon, un seul
  message refusé bloquerait toute la conversation (c'est arrivé lors des
  premiers essais, voir l'approfondissement).
- Le prix : un document joint est renvoyé au modèle à chaque message. D'où
  les limites (3 pièces jointes par message, 120 000 caractères au total), et
  l'intérêt du cache de prompt, qui n'est pas fait ici.

> **À retenir**
> Le client désigne, le serveur résout : c'est le même principe que l'identité, jamais prise telle quelle au client.

---

## Leçon 5 : une pièce jointe reste une donnée

```ts
return `<pieces_jointes>\n${parts.join("\n")}\n</pieces_jointes>\n${ATTACHMENT_REMINDER}`;
```

- Un document choisi par l'utilisateur n'en devient pas plus **fiable** :
  il peut contenir une injection (jour 5, LLM01). On l'encadre donc comme les
  extraits : une balise `<piece_jointe uri="…">` dont on neutralise la
  fermeture dans le texte, puis un **rappel** placé juste après.
- Le prompt système a une règle de plus : pour une pièce jointe, citer « le
  fichier et la page », pas un numéro `[n]` (il n'y a pas d'extrait numéroté).
- Le serveur MCP renvoie le texte **brut**. C'est le client (l'API) qui sait
  comment le présenter à son modèle : la mise en forme est sa responsabilité.

> **À retenir**
> Qui choisit une donnée ne change rien à sa nature : elle est encadrée et ne donne jamais d'ordre.

---

## Leçon 6 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| bruno joint ou résume un document RH (ou un nom inventé, `rh.pdf`) | 400 « Document introuvable : … », pas d'appel au modèle ; le navigateur retire ce message de l'historique, sans bouton « Réessayer » |
| une référence d'un message **ancien** ne se résout plus (document retiré, droits changés) | elle devient « [pièce(s) jointe(s) indisponible(s) : …] » ; la conversation continue |
| URI hors `rag://documents` (`file:///etc/passwd`) | 400 du schéma : « Seules les ressources rag://documents peuvent être jointes. » |
| 4 pièces jointes sur un message | 400 « Au plus 3 pièces jointes par message. » |
| trop de documents dans la conversation (> 120 000 caractères) | 400 « commence-en une nouvelle » |
| prompt inconnu | 400, message du serveur MCP |
| serveur MCP ou AS arrêté | `/api/mcp/*` en 503 ; menu « Prompts indisponibles. », 📎 « (indisponible) » ; le chat continue |
| base arrêtée pendant une lecture | erreur MCP neutre « Lecture impossible (base indisponible) » ; détail dans les logs du serveur |

---

## Leçon 7 : synthèse

### Les idées à emporter

1. MCP a trois primitives, qui se distinguent par **qui décide** : le modèle, l'application, l'utilisateur.
2. Ressources et prompts passent par la même session, le même jeton et donc les mêmes droits que les outils.
3. Modèle d'URI, `list` et `complete` : le client découvre ce qui existe **pour cet utilisateur**.
4. Le navigateur envoie des références ; l'API les résout à chaque requête.
5. Un document joint reste une donnée encadrée.

### Vérifications manuelles

Avec `npm run dev` (auth, mcp, api, web) :

1. **Le menu `/`** : connecte-toi en chloe, tape `/` : trois prompts. Tape
   `/resu`, Entrée, puis `reg` dans « fichier » : la liste propose
   `reglement-interieur.pdf`. Choisis-le et envoie : la réponse cite les pages.
2. **Les droits** : passe en bruno, clique sur 📎 Joindre. Seuls
   « Catalogue des documents » et `discordinvites.pdf` apparaissent.
3. **À la main** :
   ```bash
   curl -s -H 'X-User-Id: bruno' -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"Résume","attachments":["rag://documents/reglement-interieur.pdf"]}]}' \
     http://127.0.0.1:3000/api/chat            # 400 {"error":"Document introuvable : reglement-interieur.pdf"}
   curl -s -H 'X-User-Id: chloe' -H 'Content-Type: application/json' \
     -d '{"prompt":"resumer_document","argument":"fichier","value":"reg"}' \
     http://127.0.0.1:3000/api/mcp/complete     # {"values":["reglement-interieur.pdf"]}
   ```
4. **Le journal** : avec `CHAT_DEBUG=true`, l'événement `modèle → envoyé`
   montre le bloc `<pieces_jointes>` suivi du rappel.
5. **L'Inspector** (stdio, voir `.mcp.json`) : les onglets *Resources* et
   *Prompts* listent la même chose, pour `MCP_USER_ID`.

### Pour aller plus loin (non fait, volontairement)

Les notifications `resources/list_changed` après une ingestion,
l'abonnement à une ressource (`resources/subscribe`), le cache de prompt pour
les documents joints, un outil `read_document` pour que le modèle lise un
document entier de lui-même, et les ressources binaires (le PDF d'origine).

---

## Corrigé des questions

**L1.1** Un outil, puisque c'est le modèle qui décide. Une ressource n'est
lue que si le client choisit de la lire.

**L3.1** Une enum figerait la liste dans la déclaration du prompt. Elle serait
la même pour tous les utilisateurs, et révélerait donc les documents RH à
bruno. L'autocomplétion, elle, calcule la liste à chaque demande, avec les
droits de la session.

---

## Pour aller plus loin dans le code

Pour voir comment le code est écrit, fichier par fichier, lis
[l'approfondissement](approfondissement/jour-6-ressources-prompts.md).
