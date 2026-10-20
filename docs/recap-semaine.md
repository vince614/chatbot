# Récapitulatif de la semaine : un chatbot RAG, de zéro à durci

> Ce qu'il faut retenir de cinq jours de construction. Chaque section renvoie
> à son cours détaillé dans [`docs/cours/`](cours/README.md).
> Schéma d'ensemble : [`docs/architecture.md`](architecture.md) ·
> Sécurité : [`security/SECURITE.md`](../security/SECURITE.md).

## En une page

Un assistant documentaire d'entreprise :
- **apps/web** : React, rendu Markdown sûr, historique chiffré dans le navigateur ;
- **apps/api** : Fastify, `/api/chat` en SSE, boucle d'outils, client MCP ;
- **apps/mcp-server** : `search_documents` et `list_documents`, en stdio ou HTTP ;
- **packages/rag** : ingestion, embeddings, recherche hybride, droits d'accès ;
- **Postgres + pgvector** : documents, chunks, vecteurs, groupes autorisés.

Il répond **uniquement** à partir des documents que l'utilisateur a le droit
de lire, **cite** ses sources, dit « je ne sais pas » quand il ne trouve pas,
et sa qualité est **mesurée** à chaque changement.

| Score final (chloe, mode tool, hybride) | Recherche | Citation | Abstention | Exactitude |
| --- | --- | --- | --- | --- |
| 20/10, après la journée sécurité | 16/16 | 16/16 | 16/20 | 16/16 |

## Les dix principes qui reviennent tout le temps

1. **Le navigateur ne parle jamais au modèle.** Les clés vivent sur le serveur.
2. **Le modèle demande, le code décide.** Il n'exécute rien, ne choisit pas
   l'identité, ne contrôle pas les droits.
3. **Une interface isole chaque dépendance** (fournisseur LLM, embeddings,
   transport MCP) : on en change sans toucher au reste.
4. **Refus par défaut** : pas d'utilisateur → 401 ; pas d'ACL → invisible ;
   pas `readOnly` → pas exécuté ; pas `CHAT_DEBUG` → pas de debug.
5. **Contrôler le plus tôt possible, de façon déterministe** : les droits dans
   le `WHERE`, avant le classement ; le modèle ne voit que l'autorisé.
6. **Ce qui entre dans le contexte du modèle est une donnée**, délimitée,
   numérotée, annoncée comme telle — avant et après.
7. **Ce qui sort du modèle est une entrée non fiable** : on la rend en liste
   blanche, sous CSP.
8. **Une erreur est un résultat** pour le modèle (outil en échec), un message
   clair pour l'utilisateur, une ligne de métadonnées dans les logs.
9. **On mesure au lieu de supposer** : jeu de test, graders, juge calibré,
   historique ; sondes avant / après pour la sécurité.
10. **Ce qui ne doit pas fuiter ne doit pas être là** : ni secret dans le
    prompt, ni contenu dans les logs.

---

## Jour 1 — Le flux d'un message et les outils

**Le streaming de bout en bout** ([cours](cours/jour-1-flux-dun-message.md))
- Chaîne : générateur côté SDK → `res.write` → `reader.read` → `setState`.
  Chaque maillon transmet tout de suite.
- **SSE** = `event:` + `data:` + une ligne vide ; un tampon recolle les
  événements coupés entre deux paquets réseau.
- **Valider avant de streamer** : un 400 n'est possible qu'avant les en-têtes.
- **Deux `AbortController`** (navigateur et serveur), reliés par la fermeture
  de la connexion : Stop annule vraiment l'appel payant.
- Un seul fichier (`anthropic.ts`) connaît le SDK : interface + classe + fabrique.

**Le tool use** ([cours](cours/jour-1-appel-doutils.md))
- Décrire → le modèle demande → **nous** exécutons → nous renvoyons → il conclut.
- Un outil = nom, description **écrite pour le modèle** (c'est du prompt),
  schéma Zod qui décrit et valide, fonction typée. Jamais d'`eval`.
- Un appel streamé se reconstitue avec un tampon par bloc.
- Boucle plafonnée à **5 tours** ; un échec d'outil est un résultat, pas une
  erreur de requête.

## Jour 2 — Le RAG : retrouver, répondre, mesurer

**L'ingestion** ([cours](cours/jour-2-ingestion.md))
- PDF → texte par page → nettoyage → chunks de ~**500 tokens**, coupés sur les
  paragraphes, **15 % de recouvrement** → embeddings Voyage (1024 dim) → Postgres.
- **Même modèle et même dimension** pour les documents et les questions.
- **Idempotence** : le sha256 du fichier décide ; écritures en transaction
  courte, tout ou rien ; le travail lent hors transaction.
- `<=>` = distance cosinus ; score = 1 − distance ; sans index sous ~100 000
  chunks, la recherche est exacte.

**La réponse sourcée** ([cours](cours/jour-2-recherche-reponse.md))
- Chercher → assembler → générer → montrer. Les **règles dans le prompt
  système**, les **documents dans le dernier message**, numérotés.
- Une même numérotation `[n]` relie le texte aux sources, du prompt à l'écran.
- Jamais de réponse sans sources : une panne de recherche donne une erreur
  claire. Recherche bornée dans le temps (10 s).
- Le corpus borne la qualité : des doublons évincent les bons passages.

**Le jeu de test** ([cours](cours/jour-2-jeu-de-test.md))
- 20 questions typées (factuelle, reformulée, identifiant, tableau,
  combinaison, **sans réponse**), écrites depuis la source.
- Un run enregistre ses réglages, sinon il ne se compare à rien.
- Deux notes séparées disent **où** est le problème : recherche ou génération.

## Jour 3 — Mieux chercher, et seulement l'autorisé

**La recherche hybride** ([cours](cours/jour-3-hybride.md))
- Le vectoriel comprend le **sens**, le plein texte retrouve les **termes
  exacts** (identifiants). L'un rate ce que l'autre trouve.
- Plein texte Postgres : `tsvector` + index GIN, normalisation par langue ;
  `ts_rank` est un BM25 simplifié, sans IDF.
- **RRF** fusionne des **rangs**, jamais des scores, et récompense l'accord.
- Vérifier le découpage des identifiants avec `ts_debug`, pas le supposer.

**Les droits d'accès** ([cours](cours/jour-3-droits.md))
- Un seul point de contrôle : **la requête SQL** (`allowed_groups && groupes`),
  dans **chaque** branche de l'hybride, **avant** le classement.
- Les droits vivent sur les documents (`acl.json`), réappliqués à chaque ingestion.
- Le modèle n'est **pas** un maillon du contrôle d'accès.
- *Un filtre parfait sur la mauvaise identité laisse tout passer* :
  `X-User-Id` est un remplaçant d'exercice, falsifiable.
- Changer d'utilisateur vide l'historique (sinon fuite par la conversation).

## Jour 4 — Évaluer, ouvrir par MCP, mémoriser

**L'évaluation automatique** ([cours](cours/jour-4-evaluation.md))
- Un critère, une fonction, une raison ; non applicable n'est pas réussi.
- **Tout ce qui se vérifie se vérifie par code** ; le juge LLM ne voit que le
  reste (l'exactitude).
- Un juge est un instrument : distinct du modèle qui répond, en JSON validé,
  **calibré contre un humain**.
- `npm run eval` → rapport + une ligne dans `history.jsonl`.

**Le serveur MCP** ([cours](cours/jour-4-serveur-mcp.md))
- MCP sépare celui qui a des **capacités** (serveur) de celui qui a un
  **modèle** (client).
- En stdio, **stdout appartient au protocole** ; tout le reste va sur stderr.
- Le code commun vit dans un package (`@chatbot/rag`), pas dans des chemins relatifs.
- **L'identité n'est jamais un paramètre que le modèle remplit.**

**L'API, client MCP** ([cours](cours/jour-4-client-mcp.md))
- Le client stdio lance son serveur : il fixe la commande, l'environnement,
  donc l'identité → **un processus par utilisateur**.
- `RAG_MODE=tool` : le modèle décide *si* et *quoi* chercher. Plus naturel,
  mais une garantie en moins : on la mesure (`recherches`).
- Une panne MCP n'emporte que la recherche, et le dit.

**Le serveur MCP distant** ([cours](cours/jour-4-serveur-distant.md))
- Le protocole ne dépend pas du transport : les outils n'ont pas changé.
- Streamable HTTP : un endpoint, une réponse par requête ; l'identifiant de
  session est une étiquette, **pas une preuve d'identité**.
- Jeton à **chaque** requête, comparé **en temps constant**, jamais écrit dans
  un log ; session liée au jeton qui l'a ouverte ; Host et Origin vérifiés.
- Le jeton statique est un exercice ; la production, c'est OAuth 2.1 + TLS.

**La mémoire chiffrée** ([cours](cours/jour-4-memoire-chiffree.md))
- IndexedDB (objets, octets, `CryptoKey`) plutôt que localStorage.
- **AES-GCM 256** : confidentialité + intégrité, **IV neuf à chaque écriture**,
  AAD qui lient le chiffré à sa fiche ; métadonnées chiffrées aussi.
- Clé **non extractible** : on ne peut pas la voler, mais tout code de la page
  peut l'utiliser. Le chiffrement au repos ne protège pas d'une XSS.
- Sauvegarde en *throttle* (pas *debounce*) pendant le streaming.

## Jour 5 — La sécurité : attaquer, puis durcir et prouver

**Phase 1 — reproduire sans corriger** ([`security/attacks/`](../security/attacks/README.md))
- LLM01 injection indirecte : **résistant** (le texte caché d'un PDF est
  pourtant extrait comme le texte visible).
- LLM05 sortie Markdown : **partiel** — HTML brut échappé, mais **image →
  requête sortante sans clic**.
- LLM10 consommation : **vulnérable** — ni rate limit ni budget, 84 caractères
  déclenchent 3 recherches + 4 appels modèle.

**Phase 2 — durcir et prouver** ([cours](cours/jour-5-securite.md))

| Risque | Correction | Preuve avant → après |
| --- | --- | --- |
| LLM05 rendu | `safeUrls.ts` : images et liens en liste blanche | 6 problèmes → 0 ; 1 hit témoin → 0 |
| LLM05 navigateur | CSP stricte sans `'unsafe-inline'` + en-têtes | 4 injections exécutées → 4 violations, 0 requête |
| LLM01 | Verrou sur les outils à effet de bord ; rappel après les extraits | action exécutée → refusée ; marqueur 0 → 0 |
| LLM07 | `debug` décidé par le serveur (`CHAT_DEBUG`) | prompt livré au client → non |
| LLM02 | `safeErrorReason` dans les logs d'erreur | 3/3 fuites → 0/3 |

- **Méthode** : sonde inoffensive AVANT, correction, même sonde APRÈS, plus un
  **témoin positif** (ce qui doit marcher marche encore), puis l'éval.
- **Défense en profondeur** : rendu sûr + CSP ; prompt + verrou. Chaque
  couche couvre l'angle mort d'une autre.
- **Séparer ce qui dépend du modèle** (probabiliste : à évaluer en continu)
  **de ce que garantit le code** (déterministe : se prouve une fois).
- Une défense par prompt n'est jamais totale : la frontière entre donnée et
  instruction est **sémantique** (« quelle est la référence de la charte ? »
  doit légitimement renvoyer la chaîne repère).

---

## Les commandes à connaître

```bash
npm run db:up && npm run db:migrate         # Postgres + pgvector, schéma
npm run ingest                              # PDF de apps/api/data/pdfs/ + acl.json → base
npm run search -- --user bruno "question"   # recherche seule
npm run dev                                 # API :3000 + Vite :5173
npm run mcp -- --transport http             # serveur MCP distant :3100
npm run eval -- --user chloe --rag-mode tool --mode hybrid   # run complet + notation
npm run eval:history                        # l'évolution des scores
npm run typecheck
```

Sondes de sécurité : [`security/probes/README.md`](../security/probes/README.md).

## Les réglages qui comptent

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `RAG_MODE` | `tool` (le modèle cherche) ou `always` (recherche à chaque message) | `tool` |
| `RAG_SEARCH_MODE` | `vector`, `lexical` ou `hybrid` | `vector` (hybride recommandé) |
| `MCP_TRANSPORT` | `stdio` (un processus par utilisateur) ou `http` | `stdio` |
| `CHAT_DEBUG` | autorise le panneau de debug à recevoir le prompt | absent = non |

Utilisateurs de test : alice (rh), bruno (tech), chloe (rh + tech). Un run
comparable se fait avec chloe.

## Ce qui reste fragile

1. **L'identité** : `X-User-Id` est falsifiable ; droits, historique et futurs
   quotas en dépendent.
2. **La consommation** (LLM10) : aucun rate limit ni budget.
3. **L'injection** : résistance du modèle mesurée, pas garantie ; pas de cas
   d'injection dans l'éval.
4. **L'abstention** : 16/20, car le modèle dit « Je ne sais pas » mais cite
   quand même (q17–q20).
5. **Les quotas externes** : Voyage à 3 requêtes/min, crédit Anthropic déjà
   épuisé une fois.
6. **La CSP** vit dans la config Vite : à reporter dans le serveur de production.

## Les trois questions à poser en priorité sur une mission

1. **Comment les utilisateurs s'authentifient-ils, et d'où viennent leurs
   groupes ?** Tout le modèle de sécurité en dépend.
2. **Qui alimente le corpus, et l'assistant devra-t-il agir ?** Surface
   d'injection et écran de confirmation à concevoir dès le départ.
3. **Quels volumes, quel budget, quelles contraintes sur les données ?**
   Rate limit, choix des embeddings, rétention des logs et de l'historique.
