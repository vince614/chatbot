# Jour 6 · Cours 1 — Le serveur MCP distant, protégé par OAuth : le code expliqué

> [Sommaire](../README.md) · [Le cours](../jour-6-oauth-mcp.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
> Chaque extrait indique son fichier : ouvre-le à côté.

Trois chantiers dans ce cours :
- un nouveau processus, le **serveur d'autorisation** (`apps/auth-server`) ;
- le serveur MCP **vérifie des JWT** au lieu de comparer des jetons statiques (`auth.ts`, `transports/http.ts`) ;
- l'API **découvre** le serveur d'autorisation et gère les jetons de chaque utilisateur (`apps/api/src/mcp/oauth.ts`, `pool.ts`).

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `packages/rag/src/oauth.ts` | constantes partagées : émetteur, ressources, scopes, `at+jwt`, lecture du `.env` | 1, 4 |
| `apps/auth-server/src/config.ts` | le client enregistré (secret, ressources, scopes), l'annuaire, la durée des jetons | 1 |
| `apps/auth-server/src/keys.ts` | `createSigningKey` : paire ES256, `kid`, JWK publique | 3 |
| `apps/auth-server/src/token.ts` | `issueToken` : client, `subject`, `resource`, `scope`, signature | 3, 4 |
| `apps/auth-server/src/index.ts` | serveur HTTP : métadonnées RFC 8414, JWKS, `/token` | 2 |
| `apps/mcp-server/src/auth.ts` | `createJwtAuthenticator`, `sameIdentity`, traduction des erreurs de jose | 3, 4, 5 |
| `apps/mcp-server/src/config.ts` | `loadHttpConfig` : ressource, émetteur, JWKS, scope requis | 1 |
| `apps/mcp-server/src/transports/http.ts` | métadonnées RFC 9728, `WWW-Authenticate`, session liée à l'utilisateur | 2, 5 |
| `apps/api/src/mcp/oauth.ts` | `createTokenProvider` : découverte, demande, cache, invalidation | 2, 6 |
| `apps/api/src/mcp/pool.ts` | `httpTransport` : un jeton frais par requête, nouvel essai sur 401 | 6 |
| `apps/api/src/config.ts` | `loadMcpTransport` : `http` par défaut, `TokenProvider` | 6 |
| `apps/api/src/mcp/auth-probe.ts` | la sonde : 15 cas | 7 |
| `package.json` (racine) | `npm run auth`, `npm run mcp:auth-probe`, `dev` à quatre processus | 0 |

## Le parcours dans le code

bruno ouvre le chat ; c'est le premier appel de l'API au serveur MCP.

1. **Démarrage de l'AS** (`auth-server/src/index.ts`) : `loadAuthServerConfig` → `createSigningKey`
   → écoute sur 3200. Log : `prêt (http://127.0.0.1:3200, clé eW7-mCLS, jetons de 300 s)`.
2. **Démarrage du MCP** (`mcp-server/src/index.ts`) : `loadHttpConfig` → `startHttp({ resource,
   issuer, auth: createJwtAuthenticator(...) })`. Rien n'est téléchargé : le JWKS sera lu au premier jeton.
3. **Démarrage de l'API** : `loadMcpTransport(app.log)` → `{ kind: "http", url, tokens: createTokenProvider(...) }`.
4. Premier message de bruno → `pool.listTools("bruno")` → `connect` → `httpTransport(url, "bruno", tokens)`
   → `client.connect` → le SDK appelle **notre `fetch`** pour le POST `initialize`.
5. `fetch` → **`tokens.token("bruno")`** → pas de jeton → `requestToken` → **`discover`** :
   `GET /mcp` (401) → `resource_metadata` → métadonnées de la ressource → métadonnées de l'AS → `token_endpoint`.
6. `POST /token` (Basic, `subject=bruno`, `resource=http://127.0.0.1:3100/mcp`, `scope=documents:read`)
   → **`issueToken`** → JWT signé. Log AS : `jeton émis : sub=bruno aud=… scope="documents:read"`.
7. `fetch` envoie l'`initialize` avec `Authorization: Bearer …` → `handle` (`http.ts`) →
   **`auth.authenticate`** → `jwtVerify` (télécharge le JWKS, vérifie) → identité de bruno → `openSession`.
8. Requêtes suivantes : même session, `sameIdentity` compare `sub` et `client_id`.
9. 5 minutes plus tard (moins 30 s), `tokens.token("bruno")` redemande un jeton ; la session continue.

---

## `packages/rag/src/oauth.ts`

```ts
export const AGENDA_RESOURCE = "http://127.0.0.1:3300/agenda";
export const SCOPES = { documents: "documents:read", agenda: "agenda:read" } as const;
export const ACCESS_TOKEN_TYPE = "at+jwt";

export function loadMcpResource(): string {
  const explicit = process.env["MCP_PUBLIC_URL"]?.trim();
  if (explicit) return parseUrl("MCP_PUBLIC_URL", explicit);
  return `http://127.0.0.1:${loadMcpHttpPort()}/mcp`;
}
```

**Ce que fait le code**
1. Définit les deux ressources connues de l'AS : le serveur MCP (calculé) et l'agenda (fictif, rien n'y écoute).
2. `loadMcpResource` donne l'**identifiant** du serveur MCP, que l'AS met dans `aud` et que le serveur exige.
3. `parseUrl` normalise (`new URL(...).href` sans `/` final) : `http://127.0.0.1:3100/mcp` s'écrit d'une seule façon.

**Pourquoi**
- L'audience est comparée **à l'octet près**. Si l'AS et le serveur MCP calculaient chacun leur URL à leur façon (un `/` final de plus), tous les jetons seraient refusés.
- L'agenda n'existe que pour montrer `aud` : un jeton parfaitement valide, mais pour un autre service.

## `apps/auth-server/src/keys.ts`

```ts
const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG);
const jwk = await exportJWK(publicKey);
const kid = await calculateJwkThumbprint(jwk);
return { privateKey, kid, publicJwk: { ...jwk, kid, alg: SIGNING_ALG, use: "sig" } };
```

**Ce que fait le code**
1. Génère une paire ECDSA P-256 (ES256) **en mémoire**, à chaque démarrage.
2. Exporte la clé publique au format JWK et calcule son empreinte (RFC 7638), qui sert de `kid`.

**Pourquoi**
- Asymétrique : le serveur MCP n'a besoin que de la clé **publique**. Avec HS256 (un secret partagé), le serveur MCP pourrait signer des jetons lui-même, et le voler suffirait.
- Le `kid` dérivé de la clé est stable pour une clé donnée, et différent à chaque rotation.
- Une clé neuve à chaque démarrage, c'est une **rotation** gratuite à observer (vérification 5 du cours).

## `apps/auth-server/src/token.ts` — `issueToken`

```ts
if (!credentials || credentials.id !== client.clientId || !sameSecret(credentials.secret, client.clientSecret)) {
  return { status: 401, body: { error: "invalid_client", … } };
}
// …
const resource = form.get("resource") ?? "";
if (!client.resources.includes(resource)) {
  return { status: 400, body: { error: "invalid_target", … } };
}
// …
const accessToken = await new SignJWT({ scope, client_id: client.clientId })
  .setProtectedHeader({ alg: SIGNING_ALG, typ: ACCESS_TOKEN_TYPE, kid: key.kid })
  .setIssuer(config.issuer).setSubject(subject).setAudience(resource)
  .setIssuedAt().setExpirationTime(`${ttl}s`).setJti(jti)
  .sign(key.privateKey);
```

**Ce que fait le code**
1. **Client** : décode `Authorization: Basic`, compare le secret par empreintes SHA-256 et `timingSafeEqual` (comme au jour 4).
2. **Demande** : `grant_type=client_credentials`, chaque paramètre au plus une fois.
3. **Utilisateur** : `subject` doit exister dans `users.json` (`invalid_grant` sinon).
4. **Ressource** : doit être ouverte à ce client (`invalid_target`, RFC 8707).
5. **Scopes** : chacun doit être autorisé ; aucun demandé = tous ceux du client.
6. **Durée** : `expires_in` peut raccourcir, jamais allonger.
7. **Signature** : en-tête `alg`, `typ: at+jwt`, `kid` ; charge `iss`, `sub`, `aud`, `scope`, `client_id`, `iat`, `exp`, `jti`.

**Pourquoi**
- Le refus d'une ressource inconnue empêche un client de se faire délivrer un jeton pour un service qu'on ne lui a pas ouvert.
- `jti` (identifiant unique) n'est pas encore utilisé par le serveur MCP : il servirait à une **liste de révocation**. Il est déjà dans les logs de l'AS (`jti=4d4b1574`).
- `client_credentials` + `subject` n'est **pas** un flux OAuth standard. C'est la simplification annoncée dans le commentaire : en vrai, l'identité de l'utilisateur viendrait de sa connexion (authorization code + PKCE).

## `apps/auth-server/src/index.ts` — `handle`

```ts
if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
  return sendJson(res, 200, { issuer: config.issuer, token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`, … });
}
if (pathname === "/.well-known/jwks.json" && req.method === "GET") {
  return sendJson(res, 200, { keys: [key.publicJwk] }, { "Cache-Control": "public, max-age=300" });
}
```

**Ce que fait le code** : trois routes. Les métadonnées (RFC 8414), les clés publiques et `/token`. Ce dernier
exige un formulaire `application/x-www-form-urlencoded` (comme OAuth), répond `Cache-Control: no-store`
et logue chaque jeton émis **sans** le jeton.

**Pourquoi** : `no-store`, parce qu'un jeton ne doit traîner dans aucun cache. Le JWKS, lui, peut être mis en
cache : il est public, et le serveur MCP le relit quand il voit un `kid` inconnu.

## `apps/mcp-server/src/auth.ts` — `createJwtAuthenticator`

```ts
const jwks = createRemoteJWKSet(jwksUrl, { cooldownDuration: 30_000, timeoutDuration: 5_000 });
// …
({ payload } = await jwtVerify(token, jwks, {
  issuer, audience, algorithms: ["ES256"], typ: ACCESS_TOKEN_TYPE,
  requiredClaims: ["sub", "exp", "iat", "jti"], clockTolerance: 5,
}));
// …
const user = users.get(payload.sub ?? "");
if (!user) return invalidToken("utilisateur inconnu de l'annuaire");
// …
if (!scopes.includes(requiredScope)) return { ok: false, status: 403, error: "insufficient_scope", … };
```

**Ce que fait le code**
1. `createRemoteJWKSet` : un jeu de clés **distant**, téléchargé au premier besoin et gardé en cache. Une clé
   inconnue déclenche un rechargement, au plus une fois toutes les 30 s (`cooldownDuration`).
2. `bearerToken` extrait le jeton ; absent → 401 **sans** code d'erreur (RFC 6750 § 3.1).
3. `jwtVerify` vérifie la signature et chaque règle passée en option. Toute erreur part dans `rejection`.
4. `sub` → l'utilisateur de l'annuaire (avec ses groupes) ; `client_id` obligatoire.
5. Le scope `documents:read` doit être présent, sinon 403.

**`rejection`** traduit les erreurs de jose :

| Erreur jose | Réponse | Raison dans le log |
| --- | --- | --- |
| `JWTExpired` | 401 « Jeton expiré. » | `jeton expiré` |
| `JWTClaimValidationFailed` | 401 « Jeton invalide. » | `claim aud refusé (check_failed)` |
| `JWKSTimeout`, réseau | **503** | `JWKS injoignable` |
| autre `JOSEError` | 401 | son code : `ERR_JWS_INVALID`, `ERR_JOSE_ALG_NOT_ALLOWED`, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWKS_NO_MATCHING_KEY` |

**Pourquoi**
- **Les options font la sécurité.** `jwtVerify(token, jwks)` sans `audience` accepterait le jeton de l'agenda ;
  sans `algorithms`, c'est l'en-tête du jeton qui choisirait comment le vérifier.
- `clockTolerance: 5` : deux machines n'ont jamais exactement la même heure.
- 503 et pas 401 quand le JWKS est injoignable : le client ne doit pas croire que son jeton est mauvais et en redemander en boucle.

## `apps/mcp-server/src/transports/http.ts`

```ts
const metadataPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
// …
const verdict = await auth.authenticate(req.headers.authorization);
if (!verdict.ok) {
  log(`requête refusée (${verdict.status}) : ${verdict.reason}`);
  const challenge = [`resource_metadata="${metadataUrl}"`];
  if (verdict.error) challenge.push(`error="${verdict.error}"`, `error_description="${verdict.description}"`);
  if (verdict.error === "insufficient_scope") challenge.push(`scope="${scopes[0]}"`);
  if (verdict.status !== 503) res.setHeader("WWW-Authenticate", `Bearer ${challenge.join(", ")}`);
  return sendJson(res, verdict.status, { error: verdict.error ?? "unauthorized", error_description: verdict.description });
}
```

**Ce que fait le code**
1. Calcule le chemin des métadonnées selon RFC 9728 : le chemin de la ressource (`/mcp`) est **ajouté** après `/.well-known/oauth-protected-resource`.
2. Sert ces métadonnées (et `/health`) **sans** authentification.
3. Pour `/mcp`, vérifie le jeton avant tout (inchangé depuis le jour 4), et construit le `WWW-Authenticate`.
4. Sur une session existante, **`sameIdentity`** remplace `sameToken` : même `sub`, même `client_id`.
5. `allowedHosts` accepte aussi l'hôte de `MCP_PUBLIC_URL`.

**Pourquoi**
- Le chemin RFC 9728 permet à plusieurs ressources de partager une même origine, chacune avec ses métadonnées.
- `sameToken` comparait l'empreinte du jeton. Avec des jetons de 5 minutes, une session d'une demi-heure
  aurait été refusée au premier renouvellement.

## `apps/api/src/mcp/oauth.ts` — `createTokenProvider`

```ts
async token(userId) {
  const current = valid.get(userId);
  if (current && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.value;
  let request = inFlight.get(userId);
  if (!request) {
    request = requestToken(userId).then((fresh) => { valid.set(userId, fresh); return fresh; })
      .finally(() => inFlight.delete(userId));
    inFlight.set(userId, request);
  }
  return (await request).value;
},
invalidate(userId, token) {
  if (valid.get(userId)?.value === token) valid.delete(userId);
},
```

**Ce que fait le code**
1. `valid` : le jeton courant de chaque utilisateur. `inFlight` : la demande en cours.
2. Jeton présent et valide encore plus de 30 s → servi tel quel.
3. Sinon, on rejoint la demande en cours, ou on en lance une.
4. `invalidate` est **synchrone** : l'appel suivant à `token()` ne peut pas resservir le jeton refusé.
5. `requestToken` → `discover()` (une fois, mémorisée ; oubliée si elle échoue) → `POST /token`.
6. `runDiscovery` : `GET /mcp` → `resource_metadata` → vérifie `resource === mcpUrl` → `authorization_servers[0]` → vérifie `issuer` → `token_endpoint`.

**Pourquoi**
- La première version gardait des promesses dans une seule `Map`, et `invalidate` attendait la promesse
  (`.then`) avant d'effacer. Le nouvel essai repartait donc avec **le même** jeton refusé. Constaté en testant
  la rotation de clé (401 puis 503), et corrigé par cette séparation en deux `Map`.
- `fetchOrThrow` transforme `ECONNREFUSED` en `OAuthError` lisible : `OAuth : 127.0.0.1:3200 injoignable (ECONNREFUSED)`.

## `apps/api/src/mcp/pool.ts` — `httpTransport`

```ts
return new StreamableHTTPClientTransport(url, {
  fetch: async (input, init) => {
    const token = await tokens.token(userId);
    const response = await send(input, init, token);
    if (response.status !== 401) return response;
    tokens.invalidate(userId, token);
    log.info({ mcpUser: userId }, "jeton MCP refusé (401), nouveau jeton");
    return send(input, init, await tokens.token(userId));
  },
});
```

**Ce que fait le code** : le SDK appelle ce `fetch` pour chaque requête (POST, GET du flux, DELETE). On y
ajoute l'en-tête `Authorization`, et on refait la requête une fois sur un 401.

**Pourquoi**
- `requestInit.headers` (jour 4) fixait l'en-tête une fois pour toute la session. Ici, l'en-tête change avec le jeton.
- Le SDK propose aussi `authProvider` (un `OAuthClientProvider` complet, prévu pour le flux navigateur avec
  redirection). Pour un client confidentiel côté serveur, quinze lignes de `fetch` suffisent et restent lisibles.
- `isHttpFailure` compte désormais `OAuthError` comme une panne : le disjoncteur de 30 s s'applique aussi à un AS arrêté.

## `apps/api/src/mcp/auth-probe.ts`

Un script sans framework de test. Il découvre l'AS comme le ferait un client, puis fabrique chaque cas.
`UnsecuredJWT` produit l'`alg: none`. Une paire ES256 générée sur place produit la fausse signature. La
charge est modifiée en base64url, et la signature d'origine est gardée. `expires_in=1`, puis une attente de
7 s, produit l'expiration. Chaque ligne compare le statut et le code `error` de `WWW-Authenticate` à
l'attendu. Le script sort avec le code 1 si un contrôle ne correspond pas.

---

## Pour explorer toi-même

- **Décoder un jeton** : la commande de la vérification 3 du cours. Compare `exp - iat` à `AUTH_TOKEN_TTL_S`.
- **Voir le JWKS se recharger** : ajoute `console.error("[mcp] JWKS", Date.now())` dans un `fetch` personnalisé
  passé à `createRemoteJWKSet` (option `[customFetch]` de jose), puis redémarre l'AS et suis la vérification 5.
- **Retirer `audience`** de `jwtVerify`, relance `npm run mcp:auth-probe` : la ligne « aud = l'agenda » passe
  en ✗. Remets-la.
- **`AUTH_TOKEN_TTL_S=40`** dans `.env` : les logs de l'API montrent un `OAuth : jeton obtenu` toutes les
  10 s environ pendant une conversation (40 s moins la marge de 30 s).
- **Arrêter l'AS** pendant que l'API tourne : `/api/mcp/prompts` répond 503 et le menu `/` affiche
  « Prompts indisponibles. ». Une session déjà ouverte continue jusqu'à l'expiration de son jeton.
