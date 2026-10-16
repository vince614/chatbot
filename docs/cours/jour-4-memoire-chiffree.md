# Jour 4 · Cours 5 — La mémoire chiffrée

> [Sommaire](README.md) · Précédent : [Jour 4 · Cours 4 — Le serveur MCP distant](jour-4-serveur-distant.md) · [Approfondissement : le code](approfondissement/jour-4-memoire-chiffree.md)

> **Prérequis.** [Le flux d'un message](jour-1-flux-dun-message.md) (`useChat`,
> serveur sans état) et [les droits d'accès](jour-3-droits.md) (utilisateurs
> fictifs, fuite par l'historique). Au départ, l'historique vit dans l'état
> React : recharger la page efface tout.
>
> **Le fil rouge.** chloe demande « Qui est la référente télétravail ? »,
> recharge la page, ferme le navigateur, revient. Puis quelqu'un ouvre les
> DevTools sur son profil.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Pourquoi IndexedDB plutôt que localStorage ? |
| 2 | Que deviennent les données (navigation privée, effacement) ? |
| 3 | Que garantit AES-GCM, et pourquoi un IV ne sert qu'une fois ? |
| 4 | Que protège une clé « non extractible » ? |
| 5 | Pourquoi chiffrer aussi le titre et les dates ? |
| 6 | Comment sauvegarder pendant le streaming ? |
| 7 | Deux onglets, une conversation : que se passe-t-il ? |
| 8 | Contre quoi ce chiffrement ne protège-t-il pas ? |
| 9 | Quand ça se passe mal |
| 10 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Les conversations sont conservées **dans le navigateur**, chiffrées, et
**jamais côté serveur**. `/chat` n'a pas changé : il reçoit les messages de
la conversation courante, le temps d'une requête.

```
apps/web/src/storage/
  types.ts                Conversation { id, userId, titre, creeLe, modifieLe, messages }
  db.ts                   IndexedDB sans bibliothèque : base chatbot, magasins conversations et keys
  crypto.ts               AES-GCM 256 : IV neuf à chaque écriture, id et version authentifiés
  keys.ts                 la clé : générée non extractible, rangée telle quelle
  conversations.ts        le dépôt : chiffre, déchiffre, marque « illisible »
  title.ts                titre = premier message utilisateur
  autosave.ts             sauvegarde différée pendant le streaming
  useConversations.ts     liste de l'utilisateur, conversation ouverte
  ConversationSidebar.tsx le panneau : nouvelle, liste, ×, « Tout effacer… »
docs/securite/memoire-locale.md   menaces et limites
```

`useChat.ts` et `Chat.tsx` (dans `apps/web/src/chat/`) branchent le tout. Le
code utilise Web Crypto et IndexedDB natifs, sans aucune dépendance.

---

## Leçon 1 : IndexedDB plutôt que localStorage

| | localStorage | IndexedDB |
| --- | --- | --- |
| API | synchrone, bloque l'affichage | asynchrone |
| Valeurs | chaînes | objets, `ArrayBuffer`, **`CryptoKey`** |
| Taille | environ 5 Mo | une part du disque |
| Transactions | non | oui |

- **La raison décisive** : localStorage ne peut pas stocker un `CryptoKey`.
  Il faudrait exporter la clé en texte, donc la rendre extractible, ce qui
  annulerait sa meilleure protection.
- Le chiffré est fait d'octets : pas de base64 (+33 %) dans IndexedDB.
- « Tout effacer » vide conversations **et** clé dans **une** transaction :
  jamais l'une sans l'autre.
- Piège : une transaction se ferme seule dès qu'elle n'attend plus rien. On
  chiffre donc **avant** de l'ouvrir. Un `await encrypt` au milieu la
  fermerait.

> **À retenir**
> localStorage pour de petits réglages en texte, IndexedDB pour des objets,
> des octets et une clé.

---

## Leçon 2 : la vie des données dans le navigateur

- **Navigation privée** : la base fonctionne, mais elle est effacée à la
  fermeture de la fenêtre, clé comprise.
- **Effacer les données du site** : la base disparaît entièrement, et rien
  n'est récupérable. Le serveur n'a rien gardé, c'est cohérent.
- **Éviction** : le stockage est « best effort ». Le navigateur peut vider un
  site peu visité si le disque manque. `navigator.storage.persist()` existe
  pour l'éviter (non fait).
- Une conversation ne s'écrit qu'au premier message : « Nouvelle conversation »
  ne laisse pas de fiche vide.

> **À retenir**
> Une mémoire locale peut disparaître à tout moment, par choix de
> l'utilisateur ou du navigateur. C'est le prix de « jamais côté serveur ».

---

## Leçon 3 : AES-GCM et l'IV

```ts
const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
const plaintext = new TextEncoder().encode(JSON.stringify(value));
const donnees = await crypto.subtle.encrypt(
  { name: ALGORITHM, iv, additionalData: associatedData(id), tagLength: TAG_BITS },
  key,
  plaintext,
);
```

- **GCM chiffre** en mode compteur : AES chiffre `IV‖1`, `IV‖2`… et le flux
  obtenu est combiné au texte par XOR.
- **GCM authentifie** : une étiquette de 16 octets, vérifiée **avant** de
  rendre un seul octet. Un bit modifié dans le chiffré, l'IV ou les données
  additionnelles, ou une autre clé : `decrypt` échoue. On n'obtient jamais un
  texte à moitié faux.
- **Les données additionnelles authentifiées** (`chatbot/conversation/v1/<id>`)
  lient le chiffré à sa fiche. Testé : le chiffré de chloe recopié dans la
  fiche de bruno est refusé.
- **Réutiliser un IV** : deux textes chiffrés avec le même flux, leur XOR
  donne le XOR des textes, et la confidentialité tombe. Pire, on peut en
  déduire de quoi fabriquer des faux acceptés comme authentiques. D'où 12
  octets aléatoires **à chaque écriture**. Observé : deux écritures de la
  même conversation donnent des IV `2fffde9b…` puis `6d77c8cb…`.

> **À retenir**
> GCM donne la confidentialité et l'intégrité, à une condition : jamais deux
> fois le même IV avec la même clé.

**Question**
1. Pourquoi ne pas utiliser un compteur (1, 2, 3…) comme IV ?

---

## Leçon 4 : une clé non extractible

```ts
const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, ["encrypt", "decrypt"]);
if (await db.addIfAbsent(db.STORES.keys, key, KEY_NAME)) return key;
```

- `extractable: false` : `exportKey` lève `InvalidAccessError`, et les DevTools
  montrent un `CryptoKey` sans octets. IndexedDB range l'objet **tel quel**.
- **Ce que ça protège** : la clé ne peut pas être copiée ailleurs par la page.
  Un script ne peut pas l'envoyer à un serveur pour déchiffrer plus tard.
- **Ce que ça ne protège pas** : tout code dans la page peut **s'en servir**
  (`decrypt`). Et la clé est sur le disque, dans le même profil que les
  données : un attaquant qui copie le profil entier peut la retrouver.
- `add` au lieu de `put` : si un autre onglet crée sa clé au même moment, on
  prend la sienne au lieu de l'écraser.
- Après « Tout effacer », la clé en mémoire est oubliée (`forgetKey`). Sinon,
  on chiffrerait avec une clé qui n'est plus sur le disque.

> **À retenir**
> Non extractible empêche le vol de la clé, pas son usage.

---

## Leçon 5 : chiffrer aussi les métadonnées

- Sur le disque, une fiche est `{ id, v, iv, donnees }`. Le titre, l'utilisateur
  et les dates sont **dans** `donnees`. La liste se construit après
  déchiffrement.
- **En clair, ils révéleraient :**
  - le **titre** : le sujet (« Mon arrêt maladie… »), souvent la phrase la plus sensible ;
  - le **`userId`** : qui utilise ce navigateur ;
  - les **dates** : quand, combien, et un croisement possible avec des événements.
- **Ce qui reste visible** : le nombre de fiches et leur taille approximative
  (pas de bourrage).
- **Une fiche qui ne se déchiffre pas** devient « Conversation illisible » et
  peut être supprimée. Les autres restent lisibles. Comme son propriétaire
  était chiffré, elle apparaît chez tous les utilisateurs.

> **À retenir**
> Ce qui entoure les données en dit souvent autant qu'elles : on chiffre le
> tout, et on assume ce qui reste visible.

**Question**
1. Pourquoi une conversation illisible apparaît-elle chez tous les utilisateurs ?

---

## Leçon 6 : sauvegarder pendant le streaming

```ts
schedule(snapshot) {
  pending = snapshot;
  timer ??= setTimeout(() => void writeNow(), delayMs);
},
```

- Chiffrer et écrire à chaque delta serait inutile. La première demande arme
  un minuteur de **2 s**, les suivantes remplacent seulement l'état à écrire.
  On a donc **une** écriture par fenêtre de 2 s.
- **Écriture immédiate** à la fin de la réponse (fin normale, Stop ou erreur),
  quand l'onglet est masqué, et avant de rouvrir une conversation.
- On écrit un **instantané** (conversation et messages au moment de la demande),
  et les écritures sont **enchaînées**. Une écriture lente ne remplace pas une
  plus récente.
- Les messages vivent aussi dans une **ref** : la sauvegarde a besoin de leur
  valeur tout de suite, pas au rendu suivant.
- **Supprimer** la conversation ouverte, ou **tout effacer**, oublie d'abord la
  sauvegarde en attente (`discardPending`), sinon elle réécrirait ce qu'on
  supprime.
- Observé : une réponse courte donne une ligne `sauvegarde chiffrée : 2 message(s)
  en … ms` dans le journal.

> **À retenir**
> Un *throttle* (au plus une fois par période) plutôt qu'un *debounce*
> (après un silence), qui n'écrirait jamais pendant un streaming continu.

---

## Leçon 7 : deux onglets, une conversation

- Chaque onglet écrit **sa version entière**, et la **dernière écriture gagne**.
  Les messages de l'autre onglet disparaissent. C'est assumé, et signalé par
  un commentaire `LIMITE` dans `autosave.ts`.
- **Pour faire mieux :**
  - un **numéro de révision** vérifié dans la transaction d'écriture (refuser
    d'écraser plus récent, puis recharger ou fusionner) ;
  - **`BroadcastChannel`** pour prévenir les autres onglets ;
  - ou la **Web Locks API** pour qu'un seul onglet écrive.
- **Changer d'utilisateur** passe par le même mécanisme qu'un changement de
  conversation : l'ancienne est quittée et sauvegardée, rien ne reste à l'écran.
  Une garde dans `run` refuse d'envoyer une conversation au nom d'un autre
  utilisateur.

> **À retenir**
> « Dernière écriture gagne » est une règle de concurrence : simple, mais elle
> perd des données dès qu'il y a deux écrivains.

---

## Leçon 8 : ce que le chiffrement ne protège pas

Détail complet dans [`docs/securite/memoire-locale.md`](../securite/memoire-locale.md).

- **Protégé** : la lecture opportuniste du disque, un autre compte, les DevTools
  et outils d'inspection (aucun octet de clé), toute modification.
- **Pas protégé** :
  - **XSS** : le code injecté est l'application. Il appelle `decrypt`, ou lit
    simplement le DOM, puis exfiltre ;
  - une **extension** malveillante, une **session ouverte**, la **console** ;
  - le **profil copié en entier**, puisque la clé est dedans.
- **La CSP** (`script-src 'self'`, `connect-src 'self'`) limite l'exécution et
  l'exfiltration. **Le Markdown assaini** (aujourd'hui : pas de `rehype-raw`,
  URL `javascript:` filtrées) empêche le texte du modèle de devenir du code.
  C'est prévu demain.
- **Une clé dérivée d'un mot de passe** (PBKDF2, Argon2) sort le secret du
  disque. En échange : un mot de passe à chaque session, un oubli qui est
  fatal, et aucun gain contre une XSS une fois déverrouillé.

> **À retenir**
> Le chiffrement au repos protège les fichiers, pas l'application qui tourne.

**Question**
1. Pourquoi une CSP stricte ne protège-t-elle pas contre une extension malveillante ?

---

## Leçon 9 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| un octet modifié dans une fiche | « Conversation illisible », avis au clic, les autres s'ouvrent |
| le chiffré d'une fiche recopié dans une autre | refusé (AAD) : illisible |
| la clé supprimée, des fiches restent | toutes illisibles ; une nouvelle clé sert pour les suivantes |
| « Tout effacer » pendant le streaming | bouton désactivé ; après Stop : 0 conversation, 0 clé |
| suppression de la conversation ouverte | sauvegarde en attente oubliée, composer et panneau désactivés pendant l'opération |
| rechargement en plein streaming | la question est conservée ; la réponse partielle peut être perdue |
| deux onglets écrivent la même conversation | la dernière écriture gagne |
| IndexedDB indisponible | avis « Historique indisponible », le chat fonctionne sans mémoire |
| écriture ratée | erreur dans le journal ; l'état est réessayé à la sauvegarde suivante |
| changement d'utilisateur pendant un déchiffrement | le résultat tardif est ignoré |

---

## Leçon 10 : synthèse

### Les idées à emporter

1. IndexedDB, parce qu'il stocke des octets et une `CryptoKey`, en transactions.
2. AES-GCM chiffre **et** authentifie ; l'IV est neuf à chaque écriture ; les
   AAD lient le chiffré à sa fiche.
3. Une clé non extractible ne peut pas être volée par la page, mais peut être
   utilisée par tout code qui s'y exécute.
4. On chiffre aussi les métadonnées ; une fiche illisible n'emporte pas les autres.
5. Le chiffrement au repos ne protège ni d'une XSS, ni d'une extension, ni
   d'une session ouverte.

### Vérifications manuelles

Sur http://localhost:5173, avec un utilisateur choisi. Le journal d'événements
reste ouvert.

1. **Une conversation revient intacte après rechargement et après fermeture du navigateur.**
   Pose une question, attends la réponse et la ligne `sauvegarde chiffrée` du
   journal. Recharge : même conversation, mêmes sources dépliables. Quitte le
   navigateur entièrement, rouvre : elle est toujours là.
2. **Le contenu est illisible, aucun titre en clair.**
   DevTools > **Application** > Storage > **IndexedDB** > `chatbot` >
   `conversations` (↻ pour rafraîchir) : chaque entrée montre `id`, `v`,
   `iv` (12 octets) et `donnees` (`ArrayBuffer`). Aucun titre, nom, date ni
   texte.
3. **La clé apparaît comme `CryptoKey`, sans ses octets.**
   Magasin `keys` > `conversations` : `CryptoKey`, `extractable: false`,
   `AES-GCM`, 256, `encrypt`/`decrypt`. Dans la console :
   ```js
   const db = await import("/src/storage/db.ts");
   const key = await db.get(db.STORES.keys, "conversations");
   await crypto.subtle.exportKey("raw", key);   // InvalidAccessError : key is not extractable
   ```
4. **Deux écritures de la même conversation produisent des octets différents.**
   ```js
   const id = (await db.getAll(db.STORES.conversations))[0].id;
   const avant = await db.get(db.STORES.conversations, id);
   ```
   Envoie un nouveau message dans cette conversation, puis :
   ```js
   const apres = await db.get(db.STORES.conversations, id);
   [avant.iv, apres.iv]                                   // deux IV différents
   [new Uint8Array(avant.donnees).slice(0, 8), new Uint8Array(apres.donnees).slice(0, 8)]
   ```
5. **« Tout effacer » vide les deux magasins.**
   Panneau > **Tout effacer…** > **Tout effacer**. Application > IndexedDB >
   `chatbot` (↻) : `conversations` et `keys` vides. Recharge : liste vide.
6. **Une valeur corrompue rend une seule conversation illisible.**
   Crée deux conversations, puis dans la console :
   ```js
   const db = await import("/src/storage/db.ts");
   const [a] = await db.getAll(db.STORES.conversations);
   const bad = new Uint8Array(a.donnees.slice(0)); bad[10] ^= 1;
   await db.put(db.STORES.conversations, { ...a, donnees: bad.buffer });
   ```
   Recharge : une ligne « Conversation illisible » (un clic affiche l'avis,
   le × la supprime), l'autre s'ouvre normalement.
7. **Seuls les messages de la conversation courante partent vers `/chat`.**
   DevTools > **Réseau** > filtre `chat`. Ouvre une conversation, envoie un
   message, puis clique sur la requête `chat` > **Payload** : `messages`
   contient ceux de cette conversation, et aucun d'une autre. Change de
   conversation et recommence.

### Pour aller plus loin (non fait, volontairement)

Chiffrement par mot de passe (PBKDF2/Argon2, `wrapKey`), synchronisation,
export et import, CSP et Markdown assaini (demain), révision et
`BroadcastChannel` pour deux onglets, `navigator.storage.persist()`,
bourrage des tailles, tests automatisés.

---

## Corrigé des questions

**L3.1** Un compteur exige un état fiable et un seul écrivain. Deux onglets,
ou un compteur remis à zéro après un effacement, réutiliseraient un IV avec
la même clé. L'aléatoire n'a besoin d'aucun état.

**L5.1** Son `userId` était chiffré avec le reste : sans déchiffrement, on ne
sait plus à qui elle appartient. Elle ne montre que son existence.

**L8.1** Une extension n'est pas soumise à la CSP de la page : le navigateur
lui donne ses propres droits d'injection et de lecture du DOM, au-dessus
des règles du site.

---

## Pour aller plus loin dans le code

Ce cours reste volontairement court. Pour voir **comment** le code est écrit,
fichier par fichier et fonction par fonction, lis
[l'approfondissement](approfondissement/jour-4-memoire-chiffree.md).
