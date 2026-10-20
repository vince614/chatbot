# Architecture du chatbot, et où s'applique chaque contrôle de sécurité

> Les risques, corrections et preuves : [`security/SECURITE.md`](../security/SECURITE.md).
> Le cours : [Jour 5 — La sécurité](cours/jour-5-securite.md).

## Vue d'ensemble

Les pastilles **[S1]** à **[S9]** renvoient au tableau des contrôles, sous le schéma.

```mermaid
flowchart LR
  subgraph NAV["Navigateur"]
    UI["apps/web — React<br/>MessageBubble : react-markdown<br/>[S1] safeUrls · pas de rehype-raw"]
    IDB[("IndexedDB<br/>conversations chiffrées<br/>AES-GCM, clé non extractible")]
    UI <--> IDB
  end

  STATIC["Serveur statique<br/>(vite preview / prod)<br/>[S2] CSP + en-têtes"]
  STATIC -- "index.html, JS, CSS" --> UI

  subgraph API["apps/api — Fastify (127.0.0.1:3000)"]
    ROUTE["POST /api/chat (SSE)<br/>[S3] identité X-User-Id → 401<br/>validation Zod · plafonds<br/>[S7] debug seulement si CHAT_DEBUG"]
    LOOP["Boucle d'outils<br/>runConversation · 5 tours max"]
    REG["ToolRegistry<br/>[S5] verrou effets de bord<br/>(readOnly ou confirmation)"]
    PROMPT["Prompt système + rag/prompt.ts<br/>[S4] &lt;documents&gt; · données ≠ instructions<br/>rappel avant ET après · neutralizeTags"]
    LOGS[["Logs pino<br/>[S8] métadonnées seules<br/>safeErrorReason"]]
    HDR["[S2] en-têtes API<br/>CSP default-src 'none' · nosniff · no-store"]
    ROUTE --> LOOP --> REG
    PROMPT --> LOOP
  end

  LLM["Fournisseur LLM<br/>(Anthropic)<br/>clé côté serveur seulement"]

  subgraph MCP["apps/mcp-server (un par utilisateur en stdio, ou HTTP :3100)"]
    TOOLS["search_documents · list_documents<br/>readOnlyHint: true<br/>[S9] jeton Bearer temps constant (HTTP)<br/>Host/Origin vérifiés"]
    MLOG[["stderr<br/>[S8] safeErrorReason"]]
  end

  subgraph RAG["packages/rag"]
    RET["retrieve : vectoriel / lexical / hybride"]
    EMB["Embeddings Voyage"]
  end

  DB[("Postgres + pgvector<br/>documents, chunks<br/>[S6] allowed_groups && groupes")]
  INGEST["npm run ingest<br/>PDF → texte → chunks → vecteurs<br/>acl.json → allowed_groups"]

  UI -- "/api/chat (proxy Vite)" --> ROUTE
  ROUTE -- "flux SSE : delta, sources, outils" --> UI
  LOOP <--> LLM
  REG -- "outils MCP" --> TOOLS
  TOOLS --> RET --> DB
  RET --> EMB
  INGEST --> EMB
  INGEST --> DB
  TOOLS -.-> MLOG -.-> LOGS
```

## Le trajet d'une question, contrôle par contrôle

1. Le navigateur charge la page : **[S2]** la CSP dit ce qu'elle a le droit
   d'exécuter et de contacter.
2. L'utilisateur envoie un message : `/api/chat` l'identifie **[S3]** avant
   toute autre chose, valide le corps, ignore `debug` si le serveur ne
   l'autorise pas **[S7]**.
3. Le modèle reçoit un prompt système sans secret, et décide de chercher.
4. `search_documents` (serveur MCP, lecture seule) interroge Postgres **[S6]** :
   le filtre de groupes est dans le `WHERE`, avant le classement. Le prompt
   n'y est pour rien : un document hors droits n'arrive jamais au modèle.
5. Les extraits reviennent encadrés comme des **données** **[S4]**.
6. Si le modèle, influencé par un extrait, demande une action, le registre
   la refuse sans confirmation **[S5]**.
7. La réponse repart en SSE ; le navigateur la rend sans HTML brut, sans
   image ni lien vers une origine inconnue **[S1]**, sous la CSP **[S2]**.
8. Tout au long, les logs ne gardent que des métadonnées **[S8]**.

## Les contrôles

| Pastille | Contrôle | Où | Risque OWASP LLM 2025 | Ce qu'il garantit | Dépend du modèle ? |
| --- | --- | --- | --- | --- | --- |
| S1 | Rendu sûr : pas de `rehype-raw`, `urlTransform`, composants `img` / `a` en liste blanche | `apps/web/src/chat/safeUrls.ts`, `MessageBubble.tsx` | LLM05 | Le DOM ne contient ni balise vivante, ni image distante, ni lien vers une origine inconnue | non |
| S2 | CSP stricte (sans `'unsafe-inline'`) + en-têtes | `apps/web/vite.config.ts` (page), `apps/api/src/server.ts` (API) | LLM05 | Même si du HTML passait S1 : ni script inline, ni requête vers une autre origine | non |
| S3 | Identité avant tout, schéma Zod, plafonds | `apps/api/src/routes/chat.ts` | LLM10 (en partie) | Pas d'appel modèle sans utilisateur connu ; taille bornée | non — mais l'identité est **falsifiable** (exercice) |
| S4 | Documents comme données : message utilisateur / résultat d'outil, balises neutralisées, consigne avant et après | `apps/api/src/rag/prompt.ts`, `chat/search-results.ts` | LLM01 | Réduit la probabilité qu'un document soit pris pour une instruction | **oui** |
| S5 | Verrou sur les effets de bord | `apps/api/src/tools/registry.ts` | LLM01, LLM06 | Aucune action sans confirmation humaine, même si le modèle obéit au document | non |
| S6 | Droits par groupe dans le SQL | `packages/rag/src/db/repository.ts` | LLM02, LLM08 | Un document hors droits n'atteint jamais le modèle | non |
| S7 | `debug` autorisé par le serveur seulement | `apps/api/src/config.ts`, `routes/chat.ts` | LLM07 | Le client ne peut pas obtenir le prompt système par un paramètre | non |
| S8 | Logs de métadonnées, erreurs sans texte cité | `packages/rag/src/errors.ts` + tous les logs | LLM02 | Ni question, ni réponse, ni document, ni jeton, ni groupe dans les journaux | non |
| S9 | Serveur MCP HTTP : jeton par requête en temps constant, session liée au jeton, Host/Origin | `apps/mcp-server/src/auth.ts`, `transports/http.ts` | LLM06 | Un tiers ne parle pas au serveur MCP au nom d'un utilisateur | non |
| — | Mémoire locale chiffrée | `apps/web/src/storage/` | LLM02 | Historique illisible hors de l'origine (voir `docs/securite/memoire-locale.md`) | non |

La colonne « Dépend du modèle ? » est la plus importante : un seul contrôle
(S4) repose sur le comportement du modèle. C'est pourquoi il est doublé par
des contrôles déterministes en aval (S5 pour les actions, S1 et S2 pour la
sortie).
