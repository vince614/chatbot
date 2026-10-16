# Jour 4 · Cours 5 — La mémoire chiffrée : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-4-memoire-chiffree.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Tout le stockage vit dans `apps/web/src/storage/`, organisé en trois couches :
- **les octets** : `db.ts` (IndexedDB), `crypto.ts` (AES-GCM), `keys.ts` (la clé) ;
- **le métier** : `conversations.ts` (le dépôt), `title.ts`, `autosave.ts` ;
- **React** : `useConversations.ts`, `ConversationSidebar.tsx`.

`apps/web/src/chat/useChat.ts` et `Chat.tsx` les branchent. `apps/api` n'a pas changé.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `storage/types.ts` | `StoredMessage`, `Conversation`, `ConversationListItem` (lisible ou illisible) | 0, 5 |
| `storage/db.ts` | `openDb`, `get`, `getAll`, `put`, `addIfAbsent`, `remove`, `clear` | 1, 2 |
| `storage/crypto.ts` | `encryptJson`, `decryptJson`, `EncryptedRecord`, AAD | 3, 5 |
| `storage/keys.ts` | `findKey`, `getOrCreateKey`, `forgetKey` | 4 |
| `storage/conversations.ts` | `newConversation`, `listConversations`, `loadConversation`, `saveConversation`, `deleteConversation`, `wipeAll`, `toStoredMessages` | 2, 5 |
| `storage/title.ts` | `deriveTitle` | 0 |
| `storage/autosave.ts` | `createAutosave` : schedule, flush, discard | 6, 7 |
| `storage/useConversations.ts` | liste, conversation ouverte, select/create/remove/wipe/onSaved | 6, 7 |
| `storage/ConversationSidebar.tsx`, `conversations.css` | le panneau et la confirmation en deux clics | 0 |
| `chat/useChat.ts` | charge la conversation, `commit`, `scheduleSave`, `discardPending`, `flushPending` | 6, 7 |
| `chat/Chat.tsx` | assemblage, `busy`, `handleDelete`, `handleWipe`, `handleSelect` | 6 |
| `docs/securite/memoire-locale.md` | menaces et limites | 8 |

## Le parcours dans le code

chloe envoie « Qui est la référente télétravail ? » dans une conversation neuve, puis recharge.

1. **`useConversations("chloe")`** : `listConversations` → `getAll` → aucune fiche →
   `setCurrent(newConversation("chloe"))`, en mémoire seulement.
2. **`useChat`**, effet sur `conversationId` : `conversationRef.current = conversation`, `commit([])`.
3. **`send`** → **`run([question])`** : la garde `conversationRef.current.userId === userId` passe ;
   `commit([..., bulle vide])` ; **`scheduleSave()`** → `autosave.schedule(snapshot)` arme 2 s.
4. Les deltas : `updateAssistant` → `commit(...)` + `scheduleSave()`. Le minuteur n'est pas réarmé,
   seul `pending` change.
5. Fin du flux → `finally` → `scheduleSave()` + **`flush()`** → **`saveConversation`** :
   `toStoredMessages` (sans `tools`), `deriveTitle`, `modifieLe` ; **`getOrCreateKey`** →
   `generateKey(…, false, …)` → `addIfAbsent(keys, clé, "conversations")` ;
   **`encryptJson(clé, id, conversation)`** → `{ id, v, iv, donnees }` ; **`put`**.
6. `onSaved` → journal « sauvegarde chiffrée… » → `useConversations.onSaved` met la ligne en tête.
7. **Rechargement** : `listConversations("chloe")` → `getAll` → **`findKey`** → **`decryptJson`** de
   chaque fiche → filtre `userId`, tri → `loadConversation(la plus récente)` → `useChat` l'affiche.

## `storage/db.ts`

### `openDb`

```ts
request.onupgradeneeded = () => {
  const db = request.result;
  if (!db.objectStoreNames.contains(STORES.conversations)) db.createObjectStore(STORES.conversations, { keyPath: "id" });
  if (!db.objectStoreNames.contains(STORES.keys)) db.createObjectStore(STORES.keys);
};
```

**Ce que fait le code** : une seule connexion par page (`opening`, une promesse en cache).
`onupgradeneeded` crée les deux magasins à la première ouverture. `onversionchange` ferme la base si
un autre onglet ouvre une version plus récente ; `onblocked` signale le cas inverse.

**Pourquoi** :
- **Les magasins ne se créent que là** : c'est la règle d'IndexedDB. Toute évolution de structure
  passera par `DB_VERSION + 1`.
- **`keyPath: "id"` pour les conversations** : la clé est le champ `id` de la fiche. Le magasin
  `keys` n'a pas de keyPath, puisqu'un `CryptoKey` n'a pas de champ `id`, et on lui donne un nom.

### `run`

```ts
const tx = db.transaction(stores, mode);
const request = operation(tx);
tx.oncomplete = () => resolve(request ? request.result : (undefined as T));
tx.onabort = () => reject(tx.error ?? new Error("Transaction annulée."));
```

**Pourquoi** :
- **On résout sur `oncomplete` de la transaction** : une écriture n'est garantie qu'une fois la
  transaction validée. Un `onsuccess` de requête peut encore être annulé, par exemple si le quota est
  dépassé.
- **`operation` est synchrone** : rien d'extérieur n'est attendu dans la transaction, sinon elle se
  ferme (`TransactionInactiveError`). C'est pourquoi `saveConversation` chiffre **avant** d'appeler
  `put`.

### `addIfAbsent` et `clear`

- **`addIfAbsent`** : `add` échoue sur une clé existante (`ConstraintError`, qui annule la
  transaction). C'est la façon atomique de dire « crée-la, sauf si quelqu'un l'a fait avant ».
- **`clear([conversations, keys])`** vide les deux magasins dans **une** transaction : jamais la clé
  partie avec des conversations restantes, ni l'inverse.

## `storage/crypto.ts`

### `encryptJson`

```ts
const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
const plaintext = new TextEncoder().encode(JSON.stringify(value));
const donnees = await crypto.subtle.encrypt(
  { name: ALGORITHM, iv, additionalData: associatedData(id), tagLength: TAG_BITS },
  key,
  plaintext,
);
return { id, v: FORMAT_VERSION, iv, donnees };
```

**Ce que fait le code** :
1. Un IV de 12 octets, tiré au hasard **à chaque appel**.
2. La valeur en JSON, puis en octets UTF-8.
3. AES-GCM avec une étiquette de 128 bits. `donnees` contient le chiffré **suivi** de l'étiquette :
   c'est le format de Web Crypto, qui la vérifie et la retire lui-même au déchiffrement.
4. Les données additionnelles authentifiées : `chatbot/conversation/v1/<id>`.

**Pourquoi** :
- **12 octets** : la taille pour laquelle GCM est conçu. Les autres tailles passent par une
  dérivation supplémentaire.
- **L'IV en clair dans la fiche** : il n'est pas secret, il doit seulement ne jamais servir deux
  fois.
- **Les AAD** : sans elles, `{ iv, donnees }` de la fiche A recopiés dans la fiche B seraient
  acceptés. L'id ne peut pas être chiffré, puisqu'il sert de clé au magasin, mais il peut être
  **authentifié**. La version aussi : un futur format v2 ne sera jamais pris pour du v1.

### `decryptJson`

```ts
if (!isEncryptedRecord(record)) throw new DecryptionError("Fiche mal formée.");
// …
} catch {
  throw new DecryptionError("Authentification échouée : données modifiées ou clé différente.");
}
```

**Pourquoi** :
- **`isEncryptedRecord` d'abord** : une fiche abîmée (IV de mauvaise taille, `donnees` qui n'est
  pas un `ArrayBuffer`) donne une erreur claire plutôt qu'une `TypeError` de Web Crypto.
- **Un seul message pour tous les échecs d'authentification** : Web Crypto ne lève qu'une
  `OperationError`, sans détail. Distinguer « mauvaise clé » de « données modifiées » aiderait un
  attaquant.
- **`TextDecoder` avec `fatal: true`** : un UTF-8 invalide lève une erreur au lieu de produire des
  `�`. Cela n'arrive qu'en cas de bug, puisque GCM a déjà authentifié.

## `storage/keys.ts`

```ts
cached ??= (async () => {
  const stored = await db.get<CryptoKey>(db.STORES.keys, KEY_NAME);
  if (stored) return stored;
  const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, ["encrypt", "decrypt"]);
  if (await db.addIfAbsent(db.STORES.keys, key, KEY_NAME)) return key;
  const winner = await db.get<CryptoKey>(db.STORES.keys, KEY_NAME);
  if (!winner) throw new Error("Clé introuvable après sa création.");
  return winner;
})();
```

**Ce que fait le code** : la clé est relue, ou créée puis ajoutée. Si l'ajout échoue parce qu'un
autre onglet a gagné, on relit la sienne. Le tout est gardé en mémoire sous forme de promesse.

**Pourquoi** :
- **`false`** : non extractible. Les usages se limitent à `encrypt` et `decrypt`, pas de `wrapKey`
  ni de `sign`.
- **Rangée telle quelle** : IndexedDB clone un `CryptoKey` (algorithme de clonage structuré) sans
  passer par du texte.
- **`findKey` ne crée rien** : lire une liste vide ne doit pas fabriquer de clé, et une fiche sans
  clé doit être signalée illisible, pas « réparée » par une clé neuve.
- **`forgetKey`** après `wipeAll` : sinon la promesse en cache garderait l'ancienne clé, qui n'est
  plus sur le disque. Tout ce qui serait écrit ensuite deviendrait illisible au rechargement.

## `storage/conversations.ts`

### `listConversations`

```ts
const records = await db.getAll<unknown>(db.STORES.conversations);
if (records.length === 0) return [];
const key = await findKey();
const items = await Promise.all(records.map((record) => readListItem(key, record)));
```

**Ce que fait le code** : il déchiffre **toutes** les fiches, en parallèle. Il garde les lisibles de
cet utilisateur, triées par `modifieLe` décroissant, puis ajoute **toutes** les illisibles.

**Pourquoi** :
- **Tout déchiffrer** : `userId`, titre et dates sont chiffrés. Pas d'index possible, donc pas de
  filtre sans déchiffrement. Avec quelques dizaines de conversations, c'est instantané.
- **Les illisibles pour tous** : leur propriétaire est inconnu.
- **`unknown`** : ce qui sort d'IndexedDB n'est pas garanti. `decryptJson` et `toConversation` le
  vérifient.

### `saveConversation` et `toStoredMessages`

```ts
const key = await getOrCreateKey();
await db.put(db.STORES.conversations, await encryptJson(key, saved.id, saved));
```

```ts
return messages
  .filter((message) => message.role === "user" || message.content !== "")
  .map(({ role, content, sources }) => (sources?.length ? { role, content, sources } : { role, content }));
```

**Pourquoi** : `encryptJson` est attendu **avant** `put`, donc hors transaction. `toStoredMessages`
retire les `tools`, qui ne sont pas persistés, et une bulle assistant vide (réponse arrêtée avant le
premier mot).

### `toConversation`

**Pourquoi** : le JSON déchiffré est authentique, puisque c'est nous qui l'avons écrit. La vérification
de forme protège contre un **changement de format** entre deux versions de l'application, pas contre
une attaque.

## `storage/autosave.ts`

```ts
function writeNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const snapshot = pending;
  pending = null;
  if (!snapshot) return chain;
  const startedIn = generation;
  chain = chain.then(async () => {
    // saveConversation(snapshot…) ; en cas d'échec : if (generation === startedIn) pending ??= snapshot
  });
  return chain;
}
```

**Ce que fait le code** :
- `schedule` remplace `pending` et arme le minuteur s'il ne l'est pas ;
- `flush` = `writeNow` ;
- `discard` oublie `pending`, incrémente `generation` et attend `chain`.

**Pourquoi** :
- **`timer ??=`** : c'est un *throttle*. Le minuteur n'est jamais réarmé par les demandes suivantes,
  d'où au plus une écriture par 2 s.
- **`chain`** : les écritures se suivent. `flush` renvoie la promesse de la dernière, ce qui permet
  d'attendre qu'elle soit sur le disque (`flushPending`).
- **La nouvelle tentative** après un échec remet l'état en attente, sauf si un plus récent attend,
  ou si un `discard` a eu lieu entre-temps (`generation`). Sinon, une conversation supprimée
  reviendrait.
- **Le commentaire `LIMITE`** documente la règle « dernière écriture gagne » entre onglets.

## `storage/useConversations.ts`

### Le chargement

```ts
useEffect(() => {
  userIdRef.current = userId;
  setCurrent(null);
  setItems([]);
  setNotice(null);
  if (!userId) return;
  let cancelled = false;
  // listConversations → loadConversation(la plus récente) ou newConversation
  return () => {
    cancelled = true;
  };
}, [userId]);
```

**Pourquoi** :
- **`setCurrent(null)` tout de suite** : rien de l'utilisateur précédent ne reste affiché pendant
  que la liste du suivant se déchiffre.
- **`cancelled`** : un déchiffrement fini après un nouveau changement d'utilisateur est ignoré. C'est
  aussi ce qui rend l'effet sûr sous `StrictMode`, qui le lance deux fois.
- **`userIdRef`** : `select` et `refresh` ne sont pas des effets, et ne peuvent pas être annulés.
  Ils comparent l'utilisateur du moment avant d'écrire l'état. `select` vérifie en plus
  `conversation.userId === userId`.

### `onSaved`

**Pourquoi** : il met à jour la **ligne** (titre, heure) et la place en tête, sans toucher à
`current`. Changer `current` relancerait l'effet de chargement de `useChat` en pleine écriture.

## `chat/useChat.ts`

### `commit` et les refs

```ts
const commit = useCallback((next: UiMessage[] | ((prev: UiMessage[]) => UiMessage[])) => {
  const value = typeof next === "function" ? next(messagesRef.current) : next;
  messagesRef.current = value;
  setMessages(value);
}, []);
```

**Pourquoi** : `setMessages` ne met l'état à jour qu'au rendu suivant. `flush()`, appelé juste après
la fin du flux, lirait sinon des messages sans le dernier delta. Toutes les mises à jour passent par
`commit`, et la ref est toujours exacte.

### L'effet de changement de conversation

```ts
const conversationId = conversation?.id ?? null;
useEffect(() => {
  const autosave = autosaveRef.current;
  if (abortRef.current) {
    abortRef.current.abort();
    abortRef.current = null;
    scheduleSave();
  }
  void autosave?.flush();
  conversationRef.current = conversation;
  commit(conversation?.messages ?? []);
  setStatus("idle");
  setError(null);
  // …
}, [conversationId]);
```

**Ce que fait le code** :
1. Il quitte la conversation précédente : il arrête son flux et met en attente son dernier état. À
   ce moment, `conversationRef` et `messagesRef` désignent **encore** la précédente.
2. Il écrit ce qui attend.
3. Il affiche la nouvelle.

**Pourquoi** :
- **Dépendance `conversationId` seule** : réenregistrer la même conversation (titre, date) ne doit
  pas recharger ses messages. Aucune fonction de lancement ni `t` dans les dépendances (règle du
  projet).
- **Le changement d'utilisateur passe par ici** (`current` devient `null`, puis une conversation de
  l'autre utilisateur) : l'historique et les sources du précédent disparaissent de l'écran, et de ce
  qui part au serveur. C'est l'ancien `reset()`, généralisé.

### `run`

```ts
if (!userId || conversationRef.current?.userId !== userId) return;
// …
} finally {
  if (abortRef.current === controller) {
    abortRef.current = null;
    scheduleSave();
    void autosaveRef.current?.flush();
  }
}
```

**Pourquoi** :
- **La garde** : jamais l'historique d'une conversation au nom d'un autre utilisateur.
- **`abortRef.current === controller`** : si la conversation a été quittée (effet ci-dessus) ou
  supprimée (`discardPending`), ce n'est plus à ce flux de sauvegarder.

### L'onglet masqué, `discardPending`, `flushPending`

- **`visibilitychange` (hidden)** : il écrit tout de suite ce qui attend. Testé : un rechargement
  0,5 s après l'envoi garde la question.
- **`discardPending`** : il arrête le flux, retire la bulle vide, repasse à `idle` (sinon une
  suppression qui échoue laisserait l'interface bloquée), puis `autosave.discard()`.
- **`flushPending`** : `Chat.handleSelect` l'attend avant de relire une conversation sur le disque,
  sinon on relirait la version d'avant sa dernière sauvegarde.
- **`send`** teste `abortRef.current` plutôt que `status` : deux envois dans le même rendu ne lancent
  pas deux flux.

## `chat/Chat.tsx` et `ConversationSidebar.tsx`

```ts
const handleDelete = async (id: string) => {
  setBusy(true);
  try {
    if (id === conversations.current?.id) await discardPending();
    await conversations.remove(id);
  } finally {
    setBusy(false);
  }
};
```

**Pourquoi** :
- **`busy`** désactive le composer et le panneau pendant l'opération. Un envoi dans cette fenêtre
  relancerait sinon une sauvegarde de la conversation qu'on supprime. La relecture par l'agent React
  l'a trouvé.
- **La confirmation de « Tout effacer »** est un état local du panneau (`confirmingWipe`), en deux
  clics. `window.confirm` aurait bloqué la page entière, streaming compris.
- **`currentIsNew`** : la conversation ouverte n'est pas encore dans la liste. Le panneau affiche
  « Nouvelle conversation » en italique et désactive le bouton « + », qui ne créerait qu'une autre
  conversation vide.

## Pour explorer toi-même

- **Les modules depuis la console** : Vite les sert à leur chemin. `await import("/src/storage/conversations.ts")`
  donne accès au dépôt, `"/src/storage/db.ts"` aux fiches brutes.
- **Voir l'étiquette GCM** : `donnees.byteLength` vaut la longueur du JSON plus 16. Compare
  `JSON.stringify(await s.loadConversation(id)).length` et la taille de `donnees`, en gardant en tête
  les caractères accentués, qui font 2 octets en UTF-8.
- **Casser les AAD** : recopie `{ ...ficheA, id: ficheB.id }` dans le magasin. B devient illisible.
  Retire `additionalData` des deux appels dans `crypto.ts` : B affiche maintenant le contenu de A.
  Remets les AAD.
- **Le throttle** : pose une question à réponse longue, et compte les lignes « sauvegarde chiffrée »
  du journal (environ une toutes les 2 s, puis une à la fin). Passe `SAVE_DELAY_MS` à 0 pour voir la
  différence.
- **La transaction qui se ferme** : dans `db.ts`, fais un `await crypto.subtle.digest(…)` entre
  `db.transaction(…)` et `objectStore().put(…)` (dans un essai à part). Tu obtiens
  `TransactionInactiveError`.
- **Deux onglets** : ouvre la même conversation dans deux onglets, écris dans chacun, recharge.
  Seule la dernière version reste.
- **StrictMode** : dans `main.tsx`, StrictMode lance les effets deux fois en développement. Le
  journal montre deux « conversation ouverte » au premier chargement, sans double écriture.
