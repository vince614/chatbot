# Jour 6 · Cours 1 — Le serveur MCP distant, protégé par OAuth

> [Sommaire](README.md) · Précédent : [Jour 5 · Cours 1 — La sécurité : durcir et prouver](jour-5-securite.md) · Suivant : [Jour 6 · Cours 2 — Ressources et prompts MCP](jour-6-ressources-prompts.md) · [Approfondissement : le code](approfondissement/jour-6-oauth-mcp.md)

> **Prérequis.** [Le serveur MCP distant](jour-4-serveur-distant.md) :
> Streamable HTTP, sessions, et un **jeton statique** par utilisateur
> (`mcp-tokens.json`), comparé en temps constant. Sa leçon 6 décrivait OAuth
> 2.1 sans l'implémenter : c'est ce qu'on fait ici.
>
> **Le fil rouge.** L'API demande un jeton pour bruno. Elle ne connaît
> **que** l'adresse du serveur MCP : tout le reste se découvre. Puis on
> essaie de faire passer au serveur MCP un jeton destiné à un autre service.

## Plan du cours

| Leçon | Question à laquelle elle répond |
| --- | --- |
| 0 | Qu'avons-nous construit ? |
| 1 | Qui sont les trois acteurs, et pourquoi les séparer ? |
| 2 | Comment un client trouve-t-il qui délivre les jetons ? |
| 3 | Que contient un jeton JWT, et pourquoi le croire ? |
| 4 | À quoi sert `aud` ? |
| 5 | Pourquoi un 401 et un 403 ne disent-ils pas la même chose ? |
| 6 | Comment le client vit-il avec des jetons qui expirent ? |
| 7 | Quand ça se passe mal |
| 8 | Synthèse et corrigé |

---

## Leçon 0 : vue d'ensemble

Le serveur MCP ne connaît plus aucun secret. Il accepte un jeton **signé**
par un serveur d'autorisation, à condition que ce jeton ait été émis **pour
lui** (`aud`). L'API devient un client OAuth : elle découvre ce serveur, lui
demande un jeton par utilisateur et le renouvelle.

```
apps/auth-server/                 NOUVEAU : le serveur d'autorisation (port 3200)
  src/keys.ts                     paire de clés ES256, publiée en JWKS
  src/token.ts                    POST /token : client, utilisateur, ressource, scopes → JWT
apps/mcp-server/src/
  auth.ts                         RÉÉCRIT : vérification du JWT (jose)
  transports/http.ts              métadonnées RFC 9728, WWW-Authenticate, session liée au sub
apps/api/src/mcp/
  oauth.ts                        NOUVEAU : découverte + cache des jetons
  pool.ts                         un jeton frais à chaque requête (option fetch du SDK)
  auth-probe.ts                   NOUVEAU : 15 refus et acceptations prouvés
packages/rag/src/oauth.ts         les constantes partagées (émetteur, ressources, scopes)
```

Supprimés : `mcp-tokens.ts` et `mcp-tokens.example.json`.
`MCP_TRANSPORT=http` devient la valeur par défaut. `npm run dev` lance
maintenant quatre processus : auth, mcp, api et web.

---

## Leçon 1 : trois acteurs

| Rôle OAuth | Chez nous | Ce qu'il sait |
| --- | --- | --- |
| **Serveur d'autorisation** (AS) | `apps/auth-server`, :3200 | les clients, les utilisateurs, la **clé privée** |
| **Ressource** (RS) | le serveur MCP, :3100 | la **clé publique** de l'AS, son annuaire (les groupes) |
| **Client** | l'API | son `client_id` et son `client_secret` |

- Avec le jeton statique, le serveur MCP et l'API **partageaient** un fichier
  de secrets. Celui qui volait le fichier pouvait se faire passer pour
  n'importe qui, sans limite de temps.
- Désormais, le serveur MCP ne garde **rien** qui permette de fabriquer un
  jeton : il sait seulement vérifier une signature.
- Les groupes ne sont **pas** dans le jeton : la ressource les lit dans son
  propre annuaire à partir de `sub`. Un jeton plus petit, et des droits
  toujours à jour.

> **À retenir**
> Celui qui délivre les jetons n'est pas celui qui les vérifie.

---

## Leçon 2 : la découverte

L'API n'est configurée qu'avec `MCP_HTTP_URL`. Voici comment elle trouve le reste :

```ts
const challenge = await fetchOrThrow(mcpUrl, { method: "GET" });
const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
// …
if (metadata.resource !== mcpUrl.href.replace(/\/$/, "")) {
  throw new OAuthError(`métadonnées de ressource incohérentes …`);
}
```

1. Elle envoie `GET /mcp` sans jeton. Réponse : `401`, avec
   `WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:3100/.well-known/oauth-protected-resource/mcp"`.
2. Elle lit les métadonnées de la ressource (**RFC 9728**) :
   `{"resource":"http://127.0.0.1:3100/mcp","authorization_servers":["http://127.0.0.1:3200"],…}`.
3. Elle lit les métadonnées de l'AS (**RFC 8414**) pour y trouver `token_endpoint`.
4. Elle vérifie à chaque étape que ce qu'on lui annonce correspond à ce
   qu'elle a demandé (`resource`, `issuer`). Sans ce contrôle, un serveur
   pourrait la pousser à demander un jeton pour un autre.

Observé dans le log de l'API : `OAuth : serveur d'autorisation découvert`, une seule fois par démarrage.

> **À retenir**
> Un client MCP « distant » ne se configure pas à la main : il suit les liens
> à partir d'un 401.

**Question**
1. Pourquoi les métadonnées sont-elles servies **sans** authentification ?

---

## Leçon 3 : le jeton JWT

Le contenu (la charge) d'un jeton émis pour bruno, décodé :

```json
{ "iss": "http://127.0.0.1:3200", "sub": "bruno", "aud": "http://127.0.0.1:3100/mcp",
  "scope": "documents:read", "client_id": "chatbot-api",
  "iat": 1792499944, "exp": 1792500244, "jti": "4d4b1574-…" }
```

Ce que vérifie le serveur MCP (`auth.ts`) :

```ts
({ payload } = await jwtVerify(token, jwks, {
  issuer, audience, algorithms: ["ES256"], typ: "at+jwt",
  requiredClaims: ["sub", "exp", "iat", "jti"], clockTolerance: 5,
}));
```

- **La signature** : l'AS signe avec sa clé privée ES256. Le serveur MCP
  télécharge la clé publique (`/.well-known/jwks.json`), la garde en cache et
  la choisit grâce au `kid`.
- **`algorithms: ["ES256"]`** : c'est le serveur qui impose l'algorithme, pas
  le jeton. Observé : un jeton `alg: none` est refusé avec `ERR_JOSE_ALG_NOT_ALLOWED`.
- **On ne lit pas un JWT, on le vérifie.** Sa charge n'est que du base64 :
  remplacer `sub` par `chloe` est facile, mais la signature ne correspond
  plus (`ERR_JWS_SIGNATURE_VERIFICATION_FAILED`).
- **`typ: at+jwt`** (RFC 9068) : un jeton d'identité OIDC, signé par le même
  AS, ne passe pas pour un jeton d'accès.
- **`exp`** : 5 minutes. Un jeton volé ne sert pas longtemps.

> **À retenir**
> Le serveur fait confiance à une signature et à des règles qu'il fixe
> lui-même, jamais à ce que le jeton dit de lui-même.

---

## Leçon 4 : l'audience

L'AS délivre aussi des jetons pour un second service, fictif :
l'agenda (`http://127.0.0.1:3300/agenda`). La sonde en demande un, puis le présente au serveur MCP :

```
✓ MCP : aud = l'agenda (jeton valide, autre service)  attendu 401 invalid_token  obtenu 401 invalid_token
```

Côté serveur : `requête refusée (401) : claim aud refusé (check_failed)`.

- Le jeton est **authentique**, signé, pas expiré, et il désigne bien bruno.
  Il est pourtant refusé, parce qu'il n'est pas **pour nous**.
- Sans ce contrôle, n'importe quel service qui reçoit un jeton (l'agenda,
  un serveur MCP tiers) pourrait le **rejouer** chez nous. La spécification
  MCP l'interdit dans les deux sens : un serveur MCP ne relaie jamais le
  jeton qu'il a reçu vers une autre API (*token passthrough*).
- Le client choisit l'audience avec `resource=` (**RFC 8707**) quand il
  demande le jeton. L'AS n'accepte que les ressources ouvertes à ce client :
  `resource=http://127.0.0.1:9999/autre` donne `400 invalid_target`.

> **À retenir**
> `aud` répond à la question « pour qui ce jeton a-t-il été émis ? ». Un jeton valide ailleurs ne vaut rien ici.

**Question**
1. L'agenda et le serveur MCP font confiance au même AS. Que pourrait faire un agenda compromis si le serveur MCP ne vérifiait pas `aud` ?

---

## Leçon 5 : 401, 403, 503

```ts
const challenge = [`resource_metadata="${metadataUrl}"`];
if (verdict.error) challenge.push(`error="${verdict.error}"`, `error_description="${verdict.description}"`);
if (verdict.error === "insufficient_scope") challenge.push(`scope="${scopes[0]}"`);
```

- **401** : « présente un jeton (valide) ». Il n'y a pas de code `error` sans
  jeton, et `invalid_token` dans les autres cas. Le client sait qu'il peut en redemander un.
- **403 `insufficient_scope`** : le jeton est bon, mais il ne donne pas ce
  droit. Observé avec un jeton `scope="agenda:read"`. Demander un autre jeton
  au même client ne changera rien : il faut **plus** de droits.
- **503** : l'AS est injoignable et le JWKS n'est pas en cache. Ce n'est pas
  la faute du jeton. On refuse quand même, car il n'y a jamais d'accès sans
  vérification.
- La raison exacte ne va que dans **nos** logs (`claim aud refusé`,
  `jeton expiré`, `ERR_JWS_INVALID`). Le client lit un code standard.
- La session reste liée à l'utilisateur. Comme le jeton change toutes les
  5 minutes, on compare `sub` et `client_id`, plus l'empreinte du jeton.
  Le jeton de chloe sur la session de bruno donne toujours 403.

> **À retenir**
> 401 veut dire « je ne sais pas qui tu es », 403 veut dire « je sais, et c'est non ».

---

## Leçon 6 : des jetons qui expirent

```ts
fetch: async (input, init) => {
  const token = await tokens.token(userId);
  const response = await send(input, init, token);
  if (response.status !== 401) return response;
  tokens.invalidate(userId, token);
  return send(input, init, await tokens.token(userId));
},
```

- Une session MCP dure plus longtemps qu'un jeton. Le jeton n'est donc pas
  fixé une fois pour toutes dans le transport (`requestInit`, au jour 4) : on
  le redemande **à chaque requête**, par l'option `fetch` du SDK.
- `TokenProvider` garde un jeton par utilisateur et le renouvelle
  **30 secondes** avant `exp`. Deux requêtes simultanées de bruno attendent
  la même promesse, pour éviter deux jetons.
- Un 401 malgré tout (par exemple l'AS a redémarré avec une **nouvelle clé**,
  voir `keys.ts`) : on jette ce jeton, on en redemande un et on réessaie
  **une seule fois**.
- L'API ne demande que `documents:read` : c'est le **moindre privilège**,
  même si l'AS lui accorderait aussi `agenda:read`.

> **À retenir**
> Côté client, un jeton est un cache : il expire, et on le remplace sans que l'utilisateur s'en aperçoive.

**Question**
1. Pourquoi ne réessayer qu'une fois après un 401 ?

---

## Leçon 7 : quand ça se passe mal

| Cas | Ce qui se passe |
| --- | --- |
| sans jeton | 401 + `resource_metadata`, rien n'est lu |
| jeton illisible, `alg: none`, signé par une autre clé, charge modifiée | 401 `invalid_token` |
| jeton pour l'agenda (`aud`) | 401 `invalid_token`, log `claim aud refusé` |
| jeton expiré | 401 `invalid_token` « Jeton expiré. » ; le client en reprend un |
| scope `agenda:read` seulement | 403 `insufficient_scope`, `scope="documents:read"` |
| session de bruno, jeton de chloe | 403 « Cette session appartient à un autre utilisateur. » |
| mauvais secret client | AS : 401 `invalid_client` |
| ressource ou scope non ouverts à ce client, utilisateur inconnu | AS : 400 `invalid_target`, `invalid_scope`, `invalid_grant` |
| AS arrêté (côté API) | `OAuth : 127.0.0.1:3200 injoignable (ECONNREFUSED)`, outils maison seuls, disjoncteur 30 s |
| AS redémarré (nouvelle clé) | une fois le JWKS rechargé, ancien jeton refusé (`ERR_JWKS_NO_MATCHING_KEY`), puis nouveau jeton et nouvel essai automatiques |
| `OAUTH_CLIENT_SECRET` absent ou trop court | l'API et l'AS refusent de démarrer |

---

## Leçon 8 : synthèse

### Les idées à emporter

1. Trois acteurs : l'AS signe, la ressource vérifie, le client demande. La
   ressource ne garde aucun secret.
2. Un client distant découvre l'AS à partir d'un 401 (RFC 9728, puis RFC 8414).
3. Un JWT se vérifie : signature, algorithme imposé, `typ`, `iss`, `exp`.
4. **`aud`** : un jeton n'est valable que chez le service pour lequel il a été émis.
5. Jetons courts et renouvelés côté client ; session liée à l'utilisateur, pas au jeton.

### Vérifications manuelles

Dans trois terminaux à la racine de `chatbot/` : `npm run auth`, puis
`npm run mcp -- --transport http`, puis les commandes ci-dessous. Tu peux
aussi tout lancer avec `npm run dev`.

1. **La sonde : 15 contrôles** :
   ```bash
   npm run mcp:auth-probe        # « 15/15 contrôles conformes. » (environ 8 s, sans Voyage ni LLM)
   ```
   Dans le terminal du serveur MCP, une ligne `requête refusée` par cas, avec sa raison.
2. **La découverte, à la main** :
   ```bash
   curl -si http://127.0.0.1:3100/mcp | grep -i www-authenticate
   curl -s http://127.0.0.1:3100/.well-known/oauth-protected-resource/mcp
   curl -s http://127.0.0.1:3200/.well-known/oauth-authorization-server
   ```
3. **Décoder un jeton** (sans le vérifier : n'importe qui peut le lire) :
   ```bash
   S=$(grep ^OAUTH_CLIENT_SECRET apps/api/.env | cut -d= -f2)
   curl -s -u chatbot-api:$S -d grant_type=client_credentials -d subject=bruno \
     -d resource=http://127.0.0.1:3100/mcp -d scope=documents:read http://127.0.0.1:3200/token \
     | node -e 'process.stdin.on("data",d=>{const t=JSON.parse(d).access_token;console.log(JSON.parse(Buffer.from(t.split(".")[1],"base64url")))})'
   ```
4. **Le chat en distant** : `npm run dev`, puis chloe demande « Qui est la
   référente télétravail ? ». Dans les logs : `OAuth : jeton obtenu`
   (`mcpUser: chloe`), et côté MCP `session … ouverte (utilisateur chloe)`.
5. **Rotation de clé** : redémarre seulement `npm run auth`. Les anciens
   jetons restent acceptés tant que le serveur MCP n'a pas rechargé son JWKS.
   Il le recharge quand il voit une clé inconnue (au plus une fois toutes les
   30 s), ou quand son cache a plus de 10 minutes. Pour le provoquer : pose une
   question avec **alice**, dont le nouveau jeton porte la nouvelle clé.
   Attends 30 s, puis pose une question avec **chloe**. Côté MCP, tu verras
   `requête refusée (401) : ERR_JWKS_NO_MATCHING_KEY`. Côté API, tu verras
   `jeton MCP refusé (401), nouveau jeton`, puis la réponse arrive normalement.

### Pour aller plus loin (non fait, volontairement)

Le vrai flux *authorization code* + **PKCE**, avec connexion et consentement
dans le navigateur. Viendraient ensuite : l'enregistrement dynamique des
clients (RFC 7591), la clé conservée et le JWKS à deux clés pendant la
rotation, la révocation (liste de `jti`, introspection RFC 7662), TLS, et
des scopes par primitive (outils, ressources, prompts). Le remplacement de
`X-User-Id` côté navigateur reste à faire, lui aussi.

---

## Corrigé des questions

**L2.1** Un client sans jeton doit pouvoir les lire pour savoir **où** en
obtenir un. Elles ne contiennent rien de secret.

**L4.1** Il pourrait rejouer chez nous les jetons que ses utilisateurs lui
présentent, et lire leurs documents en leur nom.

**L6.1** Si un nouveau jeton est refusé lui aussi, le problème n'est pas
l'expiration (mauvais scope, utilisateur retiré, mauvaise configuration).
Réessayer en boucle martèlerait l'AS sans rien régler.

---

## Pour aller plus loin dans le code

Pour voir comment le code est écrit, fichier par fichier, lis
[l'approfondissement](approfondissement/jour-6-oauth-mcp.md).
