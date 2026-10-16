# Approfondissement · Jour 2 · Cours 3 — Le code du jeu de test

> [← Retour au cours](../jour-2-jeu-de-test.md) · [Sommaire](../README.md)

> Ce document suit le code **tel qu'il est aujourd'hui dans le dépôt**. Lis
> d'abord le cours ; viens ici quand tu veux savoir *comment* c'est écrit.
>
> **Depuis [le serveur MCP](jour-4-serveur-mcp.md)**, le code commun du RAG
> vit dans `packages/rag/` (`@chatbot/rag`). Les chemins ci-dessous sont à
> jour ; dans les extraits, les imports et la lecture des fichiers (`.env`,
> `users.json`, `acl.json`) ont changé : c'est désormais l'application qui
> donne les chemins au package.
> Chaque extrait indique son fichier : ouvre-le à côté.

## Carte des fichiers

| Fichier | Rôle | Leçon du cours |
| --- | --- | --- |
| `apps/api/evals/questions.json` | Les 20 questions, leurs réponses et sources attendues (versionné) | 1 |
| `apps/api/src/evals/types.ts` | Chemins, schéma Zod des questions, types d'un run, petits utilitaires | 1, 2 |
| `apps/api/src/evals/run.ts` | `npm run eval:run` : rejoue les questions et écrit le run | 2, 4 |
| `apps/api/src/evals/report.ts` | Génère le rapport `.md` et le fichier de notes `.notes.json` | 3, 4 |
| `apps/api/src/evals/score.ts` | `npm run eval:score` : additionne les notes et diagnostique les échecs | 3, 4 |
| `apps/api/src/llm/types.ts`, `llm/anthropic.ts` | Le paramètre `effort` (`LlmEffort`, `output_config`) | 2 |
| `packages/rag/src/db/repository.ts` | `listDocuments` : les documents en base, pour la configuration du run | 2 |
| `apps/api/evals/runs/` | Les runs produits (ignorés par Git, cf. `.gitignore`) | 0 |

## Le parcours dans le code

1. `npm run eval:run` (racine) délègue à `apps/api`, qui lance
   `tsx src/evals/run.ts` ; les arguments après `--` sont transmis.
2. `main()` lit `--only` (`parseArgs`), charge la configuration, lit et valide
   `evals/questions.json` (`z.array(questionSchema)`).
3. Elle ouvre le pool PostgreSQL, construit `retrieve` et `llm`, puis la
   `RunConfig` (`gitCommit()`, `sha256()`, `listDocuments(pool)`).
4. Pour chaque question, `runQuestion()` appelle `retrieve`, `buildRagPrompt`,
   `llm.streamChat` et `extractCitations` ; `runs/<date>.json` est **réécrit**
   après chaque question.
5. `writeReport()` écrit `runs/<date>.md` (`renderReport`, `renderQuestion`)
   et crée `runs/<date>.notes.json` s'il n'existe pas.
6. Tu remplis le `.notes.json` à la main.
7. `npm run eval:score -- <date>` lance `src/evals/score.ts` : relecture du
   run et des notes, totaux, détail par type, échecs passés dans `diagnose()`.

## `apps/api/evals/questions.json`

Le jeu de test lui-même : un tableau JSON de 20 objets, versionné avec le code.
Voici la première entrée :

```json
  {
    "id": "q01",
    "type": "factuelle",
    "question": "On travaille combien d'heures par semaine chez Lumen ?",
    "reponse_attendue": "37 heures par semaine, réparties du lundi au vendredi.",
    "sources_attendues": [{ "fichier": "reglement-interieur.pdf", "pages": [1] }],
    "avec_reponse": true
  },
```

`id` sert de clé dans le run, le rapport et les notes ; `type` alimente le
détail par type de `eval:score` ; `sources_attendues` désigne des **pages de
PDF** ; `avec_reponse: false` marque les questions dont la bonne réponse est
« Je ne sais pas ». Le fichier passe par le schéma Zod de `types.ts`, qui
refuse toute faute de frappe (type inconnu, page à 0…).

## `apps/api/src/evals/types.ts`

Le vocabulaire commun aux trois scripts : où sont les fichiers, à quoi
ressemble une question, à quoi ressemble un run.

### Les chemins

```ts
/** apps/api/evals/ : les questions (versionnées) et les runs (ignorés par git). */
export const EVALS_DIR = fileURLToPath(new URL("../../evals/", import.meta.url));
export const QUESTIONS_FILE = `${EVALS_DIR}questions.json`;
export const RUNS_DIR = `${EVALS_DIR}runs/`;
```

`import.meta.url` est l'URL de `types.ts` ; `../../evals/` remonte à
`apps/api/` puis descend dans `evals/`, et `fileURLToPath` convertit l'URL
`file://` en chemin système. Le chemin est donc calculé **depuis le fichier
source**, pas depuis le dossier où tu lances la commande.

### Le schéma des questions

```ts
/** Une source attendue ou obtenue : un fichier et des numéros de page. */
const sourceSchema = z.object({ fichier: z.string(), pages: z.array(z.number().int().positive()) });
export type Source = z.infer<typeof sourceSchema>;

export const questionSchema = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  question: z.string().min(1),
  reponse_attendue: z.string().min(1),
  sources_attendues: z.array(sourceSchema),
  avec_reponse: z.boolean(),
});
export type EvalQuestion = z.infer<typeof questionSchema>;
```

**Ce que fait le code** :
1. `sourceSchema` décrit une source : un nom de fichier et une liste d'entiers
   strictement positifs (les numéros de page).
2. `questionSchema` décrit une question. `z.enum(QUESTION_TYPES)` n'accepte
   que les six types déclarés plus haut avec `as const` (ce `as const` fait de
   la liste un tuple de chaînes littérales, ce que `z.enum` exige).
3. `z.string().min(1)` interdit une question ou une réponse attendue vide.
4. `z.infer<typeof …>` produit le **type TypeScript** correspondant au schéma :
   `EvalQuestion` vaut `{ id: string; type: "factuelle" | … | "sans_reponse"; … }`.

**Pourquoi c'est écrit ainsi** :
- Une seule source de vérité : le schéma valide le JSON à l'exécution, et
  `z.infer` en tire le type pour la compilation. Impossible que les deux
  divergent.
- `Source` est réutilisé pour les sources attendues **et** obtenues : le
  rapport peut les comparer avec le même formatage.

### `RunConfig`, `RunResult`, `RunFile`

```ts
/** Tout ce qui peut faire varier les résultats : deux runs ne se comparent que si ceci est identique. */
export interface RunConfig {
  date: string;
  llm: { fournisseur: string; modele: string; effort: string; temperature: null };
// …
  documents: { fichier: string; sha256: string; chunks: number }[];
}

export interface RunResult {
  id: string;
  type: EvalQuestion["type"];
  question: string;
  reponse_obtenue: string | null;
  /** Les extraits que la réponse cite ([1], [3]…), dans l'ordre de citation. */
  sources_citees: (Source & { index: number })[];
  /** Les k chunks récupérés, dans l'ordre du classement. */
  chunks_recuperes: (Source & { rang: number; score: number })[];
  duree_ms: number;
  erreur: string | null;
}
```

**Ce que décrivent ces types** :
1. `RunConfig` : tout ce qui peut faire varier un résultat (la partie coupée
   contient embeddings, découpage, `k`, commit et empreintes).
   `temperature: null` est typé littéralement `null` : il dit explicitement
   « pas de température ».
2. `RunResult` : une question rejouée. `EvalQuestion["type"]` réutilise
   l'union des six types ; `reponse_obtenue` ou `erreur` reste `null`.
3. `Source & { index: number }` est une **intersection** : une source plus le
   numéro de citation. Même idée pour les chunks avec `rang` et `score`.
4. `RunFile` (`{ config, resultats }`) est la forme exacte de
   `runs/<date>.json`. Les champs sont en français et en `snake_case` parce
   qu'ils deviennent les clés du JSON que tu lis à la main.

### `runIdFromDate()` et `pageRange()`

```ts
/** « 2026-10-13T15-42-07 » : date-heure locale, sans « : » (interdit dans certains noms de fichiers). */
export function runIdFromDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Pages couvertes par un chunk : [2, 3] pour « p. 2–3 ». */
export function pageRange(pageStart: number, pageEnd: number): number[] {
  return Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i);
}
```

`runIdFromDate` construit l'identifiant en **heure locale**, sans `:`
(refusé sous Windows), et trié chronologiquement par un simple `ls` ;
`getMonth() + 1` parce que les mois JavaScript commencent à 0. Le champ
`config.date`, lui, est en ISO UTC (`toISOString()`) : un run nommé
`16-09-47` contient `"date": "…T14:09:47.430Z"`. `pageRange` transforme un
intervalle en liste : `Array.from({ length: n }, …)` crée `n` cases remplies
avec `pageStart + i`.

## `apps/api/src/evals/run.ts`

Le script `eval:run` : il rejoue chaque question dans la même chaîne que
`/chat` (recherche, prompt, modèle) et enregistre tout dans un fichier de run.

### `EFFORT`

```ts
/**
 * Le modèle n'accepte pas de température. On épingle l'effort à la valeur par
 * défaut du modèle, celle que /chat utilise sans la préciser : on évalue ainsi
 * le même comportement, et le run l'enregistre explicitement.
 */
const EFFORT: LlmEffort = "medium";
```

Une constante passée à chaque appel du modèle et recopiée dans
`config.llm.effort`. `claude-opus-5-5` refuse `temperature` (erreur 400) :
l'effort est le seul réglage, on l'**épingle** pour que le run l'enregistre
explicitement, à la valeur que `/chat` obtient sans rien préciser.

### `main()` : arguments et questions

```ts
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { only: { type: "string" } } });
  const appConfig = loadConfig();
  const dbConfig = loadDatabaseConfig();
  const embeddingConfig = loadEmbeddingConfig();

  const questionsText = await readFile(QUESTIONS_FILE, "utf8");
  const allQuestions = z.array(questionSchema).parse(JSON.parse(questionsText));
  const only = values.only?.split(",").map((id) => id.trim());
  const questions = only ? allQuestions.filter((q) => only.includes(q.id)) : allQuestions;
```

**Ce que fait le code** :
1. `parseArgs` (natif, `node:util`) reconnaît `--only <valeur>` ; toute autre
   option provoque une erreur.
2. Les trois `load…Config()` lisent les variables d'environnement.
3. Le fichier est lu **comme texte** : ce texte servira aussi à l'empreinte.
4. `z.array(questionSchema).parse` : une seule question mal formée, et le run
   s'arrête avant tout appel API.
5. `--only q10,q13` devient `["q10", "q13"]` et filtre la liste ; sans
   l'option, `only` vaut `undefined` et tout est gardé. Un id inconnu est
   simplement ignoré, sans message.

**Pourquoi c'est écrit ainsi** :
- `allQuestions` est conservé à part : le rapport en a besoin pour retrouver
  la réponse attendue de chaque résultat.

### `main()` : la configuration du run

```ts
  const pool = createPool(dbConfig.databaseUrl);
  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);
// …
    const startedAt = new Date();
    const config: RunConfig = {
      date: startedAt.toISOString(),
      llm: { fournisseur: appConfig.llm.provider, modele: appConfig.llm.model, effort: EFFORT, temperature: null },
// …
      decoupage: { tokens_par_chunk: CHUNK_TARGET_TOKENS, recouvrement: CHUNK_OVERLAP_RATIO },
      k: DEFAULT_K,
      commit: gitCommit(),
      sha256_prompt_systeme: sha256(RAG_SYSTEM_PROMPT),
      sha256_questions: sha256(questionsText),
      documents: (await listDocuments(pool)).map((d) => ({ fichier: d.fileName, sha256: d.sha256, chunks: d.chunks })),
    };
```

**Ce que fait le code** :
1. Ouvre le pool, vérifie la dimension des vecteurs, puis (partie coupée)
   construit `retrieve` et `llm` avec les **mêmes fabriques** que le serveur.
2. Remplit la `RunConfig` en allant chercher chaque valeur à sa source : les
   constantes de découpage (`CHUNK_TARGET_TOKENS`, `CHUNK_OVERLAP_RATIO`) dans
   `rag/document.ts`, `DEFAULT_K` dans `rag/retrieve.ts`, le prompt dans
   `rag/prompt.ts`.
3. `gitCommit()` et `sha256()` sont deux petites fonctions du même fichier :

```ts
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Commit courant, suffixé si l'arbre de travail contient des modifications. */
function gitCommit(): string {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${commit}-modifie` : commit;
  } catch {
    return "inconnu";
  }
}
```

   `sha256` renvoie l'empreinte hexadécimale d'un texte. `gitCommit` lance
   deux commandes Git : le commit court, puis `git status --porcelain`, qui
   n'affiche rien si l'arbre est propre. Toute sortie ajoute `-modifie`. Si
   Git est absent, on obtient `inconnu` au lieu d'un plantage.
4. `listDocuments(pool)` (voir plus bas) liste les documents en base ; on
   renomme les champs en français.

**Pourquoi c'est écrit ainsi** :
- Lire les constantes plutôt que les recopier : un changement de découpage
  est enregistré sans que tu y penses. Et le commit seul ne suffit pas (code
  non commité, documents réingérés) : d'où le suffixe et les empreintes.

### `main()` : la boucle et le rapport

```ts
    const runFile = `${RUNS_DIR}${runIdFromDate(startedAt)}.json`;
    await mkdir(RUNS_DIR, { recursive: true });
    const run: RunFile = { config, resultats: [] };
// …
    // Une question après l'autre : des appels parallèles se disputeraient les
    // quotas (Voyage : 3 requêtes/min sur ce compte) et rendraient les durées
    // incomparables.
    for (const [i, question] of questions.entries()) {
      const result = await runQuestion(question, { retrieve, llm });
      run.resultats.push(result);
      // Écrit après chaque question : un run interrompu garde ce qu'il a fait.
      await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
// …
    }

    await writeReport(runFile, run, allQuestions);
// …
  } finally {
    await pool.end();
  }
}
```

**Ce que fait le code** :
1. Nomme le fichier d'après l'heure de démarrage et crée `runs/` s'il manque.
2. `for … of questions.entries()` donne l'indice et la question ; chaque
   `await runQuestion(…)` attend la fin de la précédente : **séquentiel**.
3. Après chaque question, tout `run` est sérialisé et le fichier **réécrit**.
   La partie coupée affiche une ligne d'état (numéro, id, type, durée, `✓` ou
   début de l'erreur), jamais la question ni la réponse.
4. `writeReport` reçoit `allQuestions` ; le script compte ensuite les erreurs
   et affiche les trois chemins produits.
5. `finally` ferme le pool même si une exception remonte, sinon Node resterait
   bloqué sur les connexions ouvertes.

**Pourquoi c'est écrit ainsi** :
- Un Ctrl+C laisse un JSON valide jusqu'à la dernière question terminée ;
  le rapport, produit après la boucle, n'existe pas pour un run interrompu.
- En bas du fichier, `main().catch(…)` affiche le message d'une
  `ConfigError` sans pile et met `process.exitCode = 1`.

### `runQuestion()`

```ts
async function runQuestion(
// …
): Promise<RunResult> {
  const startedAt = performance.now();
  const result: RunResult = {
    id: question.id,
// …
    erreur: null,
  };

  try {
    const chunks = await retrieve(question.question, { k: DEFAULT_K });
    result.chunks_recuperes = chunks.map((chunk, i) => ({
      rang: i + 1,
      fichier: chunk.fileName,
      pages: pageRange(chunk.pageStart, chunk.pageEnd),
      score: Number(chunk.score.toFixed(3)),
    }));

    // Sans historique ni outils : la question seule, comme premier message de /chat.
    const prompt = buildRagPrompt(question.question, chunks);
    let answer = "";
    for await (const event of llm.streamChat({
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      effort: EFFORT,
    })) {
      if (event.type === "text") answer += event.text;
    }

    result.reponse_obtenue = answer;
    result.sources_citees = extractCitations(answer, chunks.length).map((index) => {
      const chunk = chunks[index - 1]!;
      return { index, fichier: chunk.fileName, pages: pageRange(chunk.pageStart, chunk.pageEnd) };
    });
  } catch (error) {
    result.erreur = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  result.duree_ms = Math.round(performance.now() - startedAt);
  return result;
}
```

**Ce que fait le code**, dans l'ordre du code :
1. Démarre un chronomètre (`performance.now()`) et prépare un résultat
   « vide » (tous les champs à `null`, `[]` ou 0) : en cas d'erreur, il sera
   renvoyé avec seulement `erreur` rempli.
2. `retrieve` cherche les `DEFAULT_K` (5) chunks les plus proches. Ils sont
   enregistrés **avant** l'appel au modèle, avec leur rang (1 à 5), leurs
   pages (`pageRange`) et leur score arrondi à 3 décimales.
3. `buildRagPrompt` construit le même prompt système et le même message
   utilisateur que `/chat` (extraits numérotés + question).
4. `llm.streamChat` est consommé avec `for await` ; seuls les événements
   `text` sont gardés et concaténés. Il n'y a pas d'outils, donc pas
   d'événement `tool_call` attendu.
5. `extractCitations` repère les `[n]` de la réponse (sans doublon, en
   ignorant les numéros hors limites) ; chaque numéro est traduit en fichier
   et pages grâce à `chunks[index - 1]` (les citations commencent à 1, le
   tableau à 0). Le `!` dit à TypeScript que l'élément existe, ce que garantit
   `extractCitations`.
6. Le `catch` transforme n'importe quelle erreur en texte (`Nom: message`).
7. Dans tous les cas, la durée est calculée et le résultat renvoyé : la
   fonction ne lève jamais d'exception.

**Pourquoi c'est écrit ainsi** :
- Enregistrer les chunks avant la génération garde la trace de la recherche
  même si le modèle échoue : tu peux noter la recherche quand même.
- La durée couvre tout, y compris les attentes de quota Voyage gérées par le
  client d'embeddings : c'est pour cela qu'on ne compare les durées qu'entre
  runs faits dans les mêmes conditions.

## Les modifications associées

### `LlmEffort` (`apps/api/src/llm/types.ts`)

```ts
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamChatParams {
// …
  /** Effort imposé ; sinon, celui du fournisseur par défaut. */
  effort?: LlmEffort;
}
```

Un type union des niveaux d'effort, et un champ **optionnel** dans les
paramètres de `streamChat`. `/chat` ne le passe pas ; `eval:run` le passe
toujours.

### `output_config` (`apps/api/src/llm/anthropic.ts`)

```ts
  async *streamChat({ system, messages, tools, signal, effort }: StreamChatParams): AsyncIterable<LlmEvent> {
    const stream = this.client.messages.stream(
      {
// …
        // Pas de temperature : les modèles récents la refusent (400). L'effort
        // est le réglage qui reste.
        ...(effort && { output_config: { effort } }),
      },
      { signal },
    );
```

**Ce que fait le code** : `...(effort && { … })` est un ajout conditionnel.
Si `effort` vaut `undefined`, l'expression vaut `undefined` et l'étalement
n'ajoute rien ; sinon il ajoute `output_config: { effort }` à la requête.
L'API ne reçoit donc pas de champ vide quand `/chat` n'impose rien.

### `listDocuments()` (`packages/rag/src/db/repository.ts`)

```ts
export async function listDocuments(
  pool: pg.Pool,
): Promise<{ fileName: string; sha256: string; chunks: number }[]> {
  const { rows } = await pool.query<{ file_name: string; sha256: string; chunks: string }>(`
    SELECT d.file_name, d.sha256, count(c.id) AS chunks
    FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id ORDER BY d.file_name`);
  return rows.map((row) => ({ fileName: row.file_name, sha256: row.sha256, chunks: Number(row.chunks) }));
}
```

**Ce que fait le code** :
1. `LEFT JOIN` associe chaque document à ses chunks **en gardant** ceux qui
   n'en ont aucun (`c.id` vaut alors `NULL`, et `count(c.id)` donne 0).
2. `GROUP BY d.id` donne une ligne par document ; grouper par la clé
   primaire autorise à sélectionner `d.file_name` et `d.sha256` sans les
   lister dans le `GROUP BY`.
3. `count` renvoie un `bigint`, que le pilote `pg` transmet en **chaîne** :
   d'où `chunks: string` et `Number(row.chunks)`.

L'empreinte de chaque PDF dit si le document a été modifié et réingéré entre
deux runs ; le nombre de chunks dit si le découpage a changé.

## `apps/api/src/evals/report.ts`

Transforme un run en rapport lisible et prépare le fichier de notes. Aucune
note n'est calculée ici.

Le fichier commence par deux types : `Note` (`recherche` et `reponse` de
type `0 | 1 | null`, plus un `commentaire`) et `Notes = Record<string, Note>`,
qui associe un id (`"q13"`) à sa note : c'est la forme du `.notes.json`.

### `writeReport()`

```ts
/** Écrit <run>.md et, s'il n'existe pas encore, <run>.notes.json (jamais écrasé). */
export async function writeReport(runPath: string, run: RunFile, questions: EvalQuestion[]): Promise<void> {
  const base = runPath.replace(/\.json$/, "");
  await writeFile(`${base}.md`, renderReport(base.split("/").at(-1)!, run, questions));

  const notesPath = `${base}.notes.json`;
  const notesExist = await access(notesPath).then(
    () => true,
    () => false,
  );
  if (!notesExist) {
    const notes: Notes = Object.fromEntries(
      run.resultats.map((r) => [r.id, { recherche: null, reponse: null, commentaire: "" }]),
    );
    await writeFile(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
  }
}
```

**Ce que fait le code** :
1. Retire `.json` du chemin pour obtenir la base commune des trois fichiers.
2. Écrit le `.md`, **toujours** (il est régénéré à chaque appel). L'identifiant
   du run passé à `renderReport` est le dernier segment du chemin.
3. `access` réussit si le fichier existe et échoue sinon ; les deux callbacks
   de `.then` transforment ce succès ou cet échec en booléen, sans `try/catch`.
4. Seulement si le fichier de notes n'existe pas, il est créé avec une entrée
   par résultat, toutes à `null`. `Object.fromEntries` transforme la liste de
   paires `[id, note]` en objet.

**Pourquoi c'est écrit ainsi** :
- Le `.md` se recalcule depuis le `.json` ; tes notes, elles, sont un travail
  manuel qu'aucun programme ne peut refaire. Ne jamais écraser le
  `.notes.json` protège ce travail si le rapport est régénéré.

### `renderReport()`

```ts
export function renderReport(runId: string, run: RunFile, questions: EvalQuestion[]): string {
  const { config } = run;
  const byId = new Map(questions.map((q) => [q.id, q]));

  const header = [
    `# Run ${runId}`,
    "",
    `Modèle ${config.llm.modele} (effort ${config.llm.effort}) · embeddings ${config.embeddings.modele} ·`,
// …
    `Puis : \`npm run eval:score -- ${runId}\``,
    "",
  ];

  const sections = run.resultats.map((result) => renderQuestion(result, byId.get(result.id)));
  return [...header, ...sections].join("\n");
}
```

Les questions sont indexées par id dans une `Map` ; l'en-tête est un
**tableau de lignes** (résumé de la configuration, consignes de notation
coupées ici, commande `eval:score` prête à copier), suivi d'une section par
résultat via `renderQuestion`, le tout joint par des retours à la ligne.

### `renderQuestion()` et `cell()`

```ts
function renderQuestion(result: RunResult, question: EvalQuestion | undefined): string {
  const expectedPages = question?.avec_reponse ? formatSources(question.sources_attendues) : "— (aucune réponse dans les documents)";
  const retrieved = result.chunks_recuperes
    .map((c) => `${c.rang}. ${c.fichier} ${formatPages(c.pages)} (${c.score.toFixed(3)})`)
    .join("<br>");
// …
  return [
// …
    "| | Attendu | Obtenu |",
    "| --- | --- | --- |",
    `| **Réponse** | ${cell(question?.reponse_attendue ?? "?")} | ${cell(result.erreur ? `**ERREUR** : ${result.erreur}` : (result.reponse_obtenue ?? ""))} |`,
    `| **Pages** | ${expectedPages} | récupérées :<br>${retrieved || "aucune"}<br><br>citées :<br>${cited} |`,
    "",
// …
  ].join("\n");
}
```

**Ce que fait le code** :
1. `expectedPages` : les sources attendues, ou une mention explicite pour une
   question sans réponse. `question` peut être `undefined` (question retirée
   du JSON depuis le run) : d'où les `?.` et le `?? "?"`.
2. `retrieved` : les 5 chunks, un par ligne, avec rang, pages et score.
3. `cited` (coupé) : les extraits cités par la réponse, ou « aucune ».
4. Après le titre `## q13 · tableau` et la question en citation (coupés), le
   tableau met côte à côte attendu et obtenu ; en cas d'erreur, « Obtenu »
   affiche l'erreur en gras. Une dernière ligne rappelle l'id et la durée.

Les deux petites fonctions `formatSources` et `formatPages` mettent en forme
une liste de sources et une liste de pages (`p. 1` ou `p. 2–3`).

```ts
/** Une cellule de tableau Markdown ne peut contenir ni saut de ligne ni « | ». */
function cell(text: string): string {
  return text.trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
```

`cell` rend un texte quelconque sûr pour une cellule : un `|` dans la réponse
du modèle fermerait la cellule (il devient `\|`), et un saut de ligne
terminerait la ligne du tableau (il devient `<br>`, que les visualiseurs
Markdown affichent comme un retour à la ligne). C'est aussi pour cela que les
listes de chunks sont jointes par `<br>`.

## `apps/api/src/evals/score.ts`

Le script `eval:score` : il relit un run et ses notes, puis affiche totaux,
détail par type et échecs diagnostiqués.

### Le schéma des notes et la lecture du run

```ts
const noteValue = z.union([z.literal(0), z.literal(1), z.null()]);
const notesSchema = z.record(
  z.string(),
  z.object({ recherche: noteValue, reponse: noteValue, commentaire: z.string().optional().default("") }),
);

async function main(): Promise<void> {
// …
  // Accepte l'identifiant seul ou le chemin de n'importe quel fichier du run.
  const runId = path.basename(arg).replace(/(\.notes)?\.(json|md)$/, "");
  const run = JSON.parse(await readFile(`${RUNS_DIR}${runId}.json`, "utf8")) as RunFile;
  const notes: Notes = notesSchema.parse(JSON.parse(await readFile(`${RUNS_DIR}${runId}.notes.json`, "utf8")));
```

**Ce que fait le code** :
1. `noteValue` n'accepte que `0`, `1` ou `null` (un `2` ou un `"1"` échouent) ;
   `notesSchema` est un objet à clés libres (`z.record`), `commentaire`
   absent vaut `""`.
2. (Coupé) Sans argument, le script affiche l'usage et sort avec le code 1.
3. `path.basename` puis l'expression régulière retirent `.json`, `.md` ou
   `.notes.json` : l'identifiant seul ou le chemin d'un des trois fichiers
   conviennent.
4. Le run est lu avec un simple `as RunFile` (écrit par le programme) ; les
   notes, saisies à la main, passent par Zod.

### Les totaux et le détail par type

```ts
  const rows = run.resultats.map((r) => ({ ...r, note: notes[r.id] }));
  const total = rows.length;
  const sum = (key: "recherche" | "reponse", subset = rows) => subset.filter((r) => r.note?.[key] === 1).length;
  const unrated = rows.filter((r) => r.note?.recherche == null || r.note?.reponse == null);

// …
  console.log(`Recherche : ${sum("recherche")}/${total}`);
  console.log(`Réponse   : ${sum("reponse")}/${total}`);
// …
  console.log("\nPar type              recherche   réponse");
  for (const type of QUESTION_TYPES) {
    const subset = rows.filter((r) => r.type === type);
    if (subset.length === 0) continue;
```

**Ce que fait le code** :
1. `rows` colle à chaque résultat sa note (`undefined` si l'id manque).
2. `sum` compte les notes valant exactement `1`, sur toutes les lignes ou
   sur un sous-ensemble (paramètre par défaut `subset = rows`).
3. `unrated` utilise `== null`, qui attrape `null` **et** `undefined`.
4. Les totaux portent sur **toutes** les questions : une question non notée
   compte comme ratée, et la partie coupée l'annonce dans un avertissement.
5. La boucle suit l'ordre de `QUESTION_TYPES`, saute les types absents (utile
   avec `--only`) et aligne les colonnes avec `padEnd` / `padStart`.

### Les échecs et `diagnose()`

```ts
  // Un échec se lit en croisant les deux notes : c'est ce qui dit quoi corriger.
  const failures = rows.filter((r) => r.note?.recherche === 0 || r.note?.reponse === 0);
  console.log(`\nÉchecs (${failures.length})`);
  for (const r of failures) {
    console.log(`  ${r.id} ${r.type.padEnd(12)} ${diagnose(r.note!)}${r.note?.commentaire ? ` — ${r.note.commentaire}` : ""}`);
  }
}

function diagnose({ recherche, reponse }: { recherche: 0 | 1 | null; reponse: 0 | 1 | null }): string {
  if (recherche === 0 && reponse === 0) return "erreur de RECHERCHE (le bon passage n'a pas été récupéré)";
  if (recherche === 0) return "recherche ratée mais réponse juste (autre passage, ou chance) : à surveiller";
  if (recherche === 1 && reponse === 0) return "erreur de GÉNÉRATION (le passage était là, la réponse est fausse)";
  return "notes incomplètes";
}
```

**Ce que fait le code** :
1. Un échec est une ligne avec **au moins un 0**. Une question seulement non
   notée (`null`) n'y figure pas : elle apparaît dans l'avertissement.
2. Pour chaque échec, `diagnose` traduit la paire de notes en cause probable,
   et le commentaire saisi est ajouté après un tiret.
3. L'ordre des tests compte : `0/0` d'abord (recherche), puis tout autre
   `recherche === 0` (dans un échec, cela couvre `0/1` et `0/null`), puis
   `1/0` (génération). Le seul cas restant est `null/0` : « notes
   incomplètes ».

**Pourquoi c'est écrit ainsi** :
- `0/0` est attribué à la recherche : si le passage n'a pas été récupéré, la
  réponse fausse en est la conséquence, pas la cause.

## À quoi ressemblent les fichiers produits

Le dernier run (`apps/api/evals/runs/2026-10-13T16-09-47.json`), section
`config` (resserrée ici sur moins de lignes, empreintes abrégées) :

```json
{
  "date": "2026-10-13T14:09:47.430Z",
  "llm": { "fournisseur": "anthropic", "modele": "claude-opus-5-5", "effort": "medium", "temperature": null },
  "embeddings": { "fournisseur": "voyage", "modele": "voyage-3.5", "dimension": 1024 },
  "decoupage": { "tokens_par_chunk": 500, "recouvrement": 0.15 },
  "k": 5, "commit": "0e9a35f-modifie",
  "sha256_prompt_systeme": "b71f553e…", "sha256_questions": "7ac74294…",
  "documents": [{ "fichier": "discordinvites.pdf", "sha256": "f092abe8…", "chunks": 7 }, …]
}
```

Un résultat (réponse tronquée, chunks 3 à 5 coupés) :

```json
{
  "id": "q01",
  "type": "factuelle",
  "question": "On travaille combien d'heures par semaine chez Lumen ?",
  "reponse_obtenue": "Chez Lumen SAS, la durée hebdomadaire de travail est de **37 heures**, réparties du lundi au vendred…",
  "sources_citees": [{ "index": 1, "fichier": "reglement-interieur.pdf", "pages": [1, 2] }],
  "chunks_recuperes": [
    { "rang": 1, "fichier": "reglement-interieur.pdf", "pages": [1, 2], "score": 0.663 },
    { "rang": 2, "fichier": "reglement-interieur.pdf", "pages": [2], "score": 0.569 }
  ],
  "duree_ms": 3154,
  "erreur": null
}
```

Le `.md` commence par l'en-tête de `renderReport`, puis une section par
question ; le `.notes.json` contient `{ "q01": { "recherche": null,
"reponse": null, "commentaire": "" }, … }`. Le suffixe `-modifie` indique
que ce run a été produit avec du code non commité.

## Pour explorer toi-même

- Ouvre `apps/api/evals/runs/2026-10-13T16-09-47.json` et compare, pour
  quelques questions, `chunks_recuperes` et `sources_citees` : repère à quel
  rang se trouvent les extraits cités.
- Remplis deux ou trois notes dans le `.notes.json` (dont un `0/0` et un
  `1/0`), puis lance `npm run eval:score -- 2026-10-13T16-09-47` : observe
  l'avertissement des questions non notées et les diagnostics.
- Mets volontairement `"recherche": 2` dans une note et relance
  `eval:score` : lis le message d'erreur produit par `notesSchema`.
- Rejoue seulement le fil rouge avec `npm run eval:run -- --only q13`
  (un seul appel au modèle) et compare la section `config` des deux runs.
- Lance `git status --porcelain` toi-même : c'est cette sortie qui décide du
  suffixe `-modifie` dans `gitCommit()`.
- Dans `psql`, exécute la requête de `listDocuments` en remplaçant
  `LEFT JOIN` par `JOIN` : avec un document sans chunk, la différence apparaît.
