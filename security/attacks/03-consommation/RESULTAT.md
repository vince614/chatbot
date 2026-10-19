# Attaque 3 — Consommation sans limite (OWASP LLM10)

**Date :** 2026-10-19
**Cible :** `POST /api/chat` (`apps/api/src/routes/chat.ts`)
**Utilisateur de test :** `bruno`
**Esprit du test :** mesurer, pas inonder. 6 requêtes concurrentes + quelques
requêtes isolées, charges minimales.

## Verdict : VULNÉRABLE (acceptable en local mono-utilisateur, dangereux si exposé)

Aucune limite de débit, aucun budget par utilisateur, aucun plafond de
concurrence ne protège `/api/chat`. Les seules barrières sont des **plafonds
statiques par requête**, et une petite entrée déclenche un gros travail serveur.

## Preuve statique — aucun garde-fou de débit dans le code

```
$ grep -rniE "rate.?limit|throttle|quota|429" apps/api/src
# -> aucune occurrence cote /chat (les seuls "429/quota" concernent le
#    client d'embeddings Voyage, en amont, pas la protection de l'API)
```

Deux `register` Fastify seulement : le préfixe `/api` et `chatRoutes`. Pas de
`@fastify/rate-limit`. Plafonds fixes (et c'est tout) :

| Constante | Valeur | Fichier |
|-----------|--------|---------|
| `MAX_MESSAGES` | 50 messages / requête | `routes/chat.ts` |
| `MAX_CONTENT_LENGTH` | 8 000 caractères / message | `routes/chat.ts` |
| `MAX_TOOL_TURNS` | 5 tours d'outils | `chat/conversation.ts` |
| `MAX_OUTPUT_TOKENS` | 16 000 tokens de sortie | `llm/anthropic.ts` |
| (implicite) `bodyLimit` Fastify | ~1 MiB de corps | défaut Fastify |

Pas de : requêtes/minute, requêtes concurrentes, budget de tokens par
utilisateur ou par jour, taille cumulée de l'historique au-delà de 50×8000.

## Preuve mesurée (sortie de `attack.mjs`)

### A. Les seules bornes sont statiques
```
51 messages                  -> HTTP 400 (refuse: > 50)
1 message de 8001 caracteres -> HTTP 400 (refuse: > 8000)
50 messages (plafond)        -> HTTP 200, 2221 ms   (ACCEPTE)
1 message ~8000 car.         -> HTTP 200, 1495 ms   (ACCEPTE, aucun budget par utilisateur)
```
Au-delà du plafond → 400 (schéma Zod). En dessous → accepté et exécuté, sans
aucune autre vérification (ni budget, ni historique de l'utilisateur).

### B. Aucun rate limit : 6 requêtes concurrentes du même utilisateur
```
req#0 OK 993 ms   req#1 OK 3632 ms   req#2 OK 1064 ms
req#3 OK 4051 ms  req#4 OK 1026 ms   req#5 OK 1006 ms
Total : 6/6 traitees en 4053 ms de mur. Rejets pour debit (429) : 0.
```
Les 6 ont été lancées d'un coup : le mur (4053 ms) ≈ la requête la plus longue
(4051 ms), donc elles ont été traitées **en parallèle**, sans file ni plafond de
concurrence. **Zéro 429.** Un seul utilisateur peut donc multiplier la charge
(et le coût d'API) à volonté.

### C. Amplification : petite entrée → gros travail
```
Entree : 84 caracteres
Sortie : 787 car. en 9903 ms. Appels d'outils : 3.
```
84 caractères en entrée ont déclenché **3 recherches** = 3 embeddings Voyage +
3 requêtes vectorielles + 4 appels modèle (3 tours d'outils puis la synthèse).
Le rapport travail/entrée est donc très élevé, et plafonné seulement par
`MAX_TOOL_TURNS` (5) et `MAX_OUTPUT_TOKENS` (16 000).

## Pourquoi, dans cette architecture

- `/api/chat` appelle le modèle (payant) et le service d'embeddings (payant) **à
  chaque requête**, sans compteur par appelant. L'authentification elle-même
  n'est qu'un en-tête `X-User-Id` falsifiable (cf. attaque future / attaque 1) :
  il n'y a même pas d'identité fiable à qui attribuer un quota.
- Le coût d'une requête est **asymétrique** : quelques octets envoyés peuvent
  coûter plusieurs appels modèle + embeddings et jusqu'à 16 000 tokens de sortie.
- Rien ne limite la **concurrence** : N requêtes simultanées = N générations
  simultanées.

C'est sans danger ici car l'API n'écoute que sur `127.0.0.1` en développement
mono-utilisateur. Le risque apparaît **le jour d'une exposition réseau**.

## Corrections possibles (non implémentées ici)

- **Rate limiting** : `@fastify/rate-limit`, par utilisateur authentifié (pas par
  IP seule), avec en-têtes `Retry-After` et réponses 429.
- **Budget de tokens** par utilisateur / par jour (compteur persistant), refus
  au-delà.
- **Plafond de concurrence** par utilisateur (file courte, puis 429).
- **Baisser `MAX_OUTPUT_TOKENS`** : 16 000 est généreux pour un assistant
  documentaire ; 2 000–4 000 suffisent et bornent le pire cas.
- **Abaisser le plafond d'entrée cumulé** (50×8000 = 400 Ko) si le cas d'usage ne
  le justifie pas, et garder le `bodyLimit` Fastify explicite.
- **Timeout global** par requête (il existe déjà pour la recherche, pas pour la
  génération complète).
- Prérequis transverse : une **vraie authentification** pour que les quotas
  s'attachent à une identité non falsifiable.

## Nettoyage

Aucun. Cette attaque ne modifie ni le code ni les données ; elle n'a fait que des
appels HTTP mesurés à l'API.
