// npm run eval:run -- --user <id> [--rag-mode always|tool] [--mode vector|lexical|hybrid] [--only q01,q19]
// Rejoue les questions de evals/questions.json dans la même chaîne que /chat,
// sans HTTP ni historique, une par une :
//  - always : retrieve → buildRagPrompt → LlmClient ;
//  - tool   : la boucle d'outils de /chat, avec le serveur MCP de l'utilisateur.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createPool } from "@chatbot/rag/db/pool";
import { listDocuments } from "@chatbot/rag/db/repository";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";
import { CHUNK_OVERLAP_RATIO, CHUNK_TARGET_TOKENS } from "@chatbot/rag/document";
import { createEmbeddingClient } from "@chatbot/rag/embeddings/index";
import {
  createRetriever,
  DEFAULT_K,
  HYBRID_CANDIDATES,
  type Retrieve,
  RRF_K,
  SEARCH_MODES,
  type SearchMode,
} from "@chatbot/rag/retrieve";
import { requireUser } from "@chatbot/rag/users";
import { z } from "zod";

import { runConversation } from "../chat/conversation.js";
import { createSearchResults, SEARCH_TOOL_NAME, TOOL_SYSTEM_PROMPT } from "../chat/search-results.js";
import {
  ConfigError,
  loadConfig,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  loadRagMode,
  loadSearchMode,
  RAG_MODES,
  type RagMode,
  USERS_FILE,
} from "../config.js";
import { createLlmClient, type LlmClient, type LlmEffort } from "../llm/index.js";
import { createMcpPool, loadMcpTools, type McpPool } from "../mcp/index.js";
import { buildRagPrompt, extractCitations, RAG_SYSTEM_PROMPT } from "../rag/prompt.js";
import { calculateTool, createToolRegistry, getCurrentDatetimeTool } from "../tools/index.js";
import { writeReport } from "./report.js";
import {
  type EvalQuestion,
  pageRange,
  QUESTIONS_FILE,
  questionSchema,
  type RunConfig,
  type RunFile,
  runIdFromDate,
  type RunResult,
  RUNS_DIR,
} from "./types.js";

/**
 * Le modèle n'accepte pas de température. On épingle l'effort à la valeur par
 * défaut du modèle, celle que /chat utilise sans la préciser : on évalue ainsi
 * le même comportement, et le run l'enregistre explicitement.
 */
const EFFORT: LlmEffort = "medium";

/**
 * Délai d'une recherche en mode tool. /chat coupe à 15 s ; ici on préfère
 * attendre : deux recherches en parallèle dépassent vite le quota de Voyage
 * (3 requêtes/min), et un délai dépassé mesurerait le quota, pas le modèle.
 */
const EVAL_SEARCH_TIMEOUT_MS = 120_000;

/** Les journaux du pool MCP : seulement les problèmes, sur stderr, pour ne pas noyer la progression. */
const mcpLog = { info: () => undefined, warn: (_: object, message: string) => console.error(`  ! ${message}`) };

/**
 * Exécute un run complet et renvoie son identifiant (null si les arguments
 * sont invalides). Appelée par la commande eval:run, et par eval qui enchaîne
 * ensuite les graders.
 */
export async function executeRun(args: string[]): Promise<string | null> {
  const { values } = parseArgs({
    args,
    options: {
      user: { type: "string" },
      only: { type: "string" },
      mode: { type: "string" },
      "rag-mode": { type: "string" },
    },
  });
  // Obligatoire, sans défaut : un run mesure ce que voit un utilisateur donné.
  const user = await requireUser(USERS_FILE, values.user);
  // Sans --mode : celui de RAG_SEARCH_MODE, comme /chat.
  const mode = (values.mode ?? loadSearchMode()) as SearchMode;
  if (!SEARCH_MODES.includes(mode)) {
    console.error(`--mode doit valoir ${SEARCH_MODES.join(", ")} (reçu : "${mode}").`);
    process.exitCode = 1;
    return null;
  }
  // Sans --rag-mode : celui de RAG_MODE, comme /chat.
  const ragMode = (values["rag-mode"] ?? loadRagMode()) as RagMode;
  if (!RAG_MODES.includes(ragMode)) {
    console.error(`--rag-mode doit valoir ${RAG_MODES.join(", ")} (reçu : "${ragMode}").`);
    process.exitCode = 1;
    return null;
  }
  const appConfig = loadConfig();
  const dbConfig = loadDatabaseConfig();
  const embeddingConfig = loadEmbeddingConfig();

  const questionsText = await readFile(QUESTIONS_FILE, "utf8");
  const allQuestions = z.array(questionSchema).parse(JSON.parse(questionsText));
  const only = values.only?.split(",").map((id) => id.trim());
  const questions = only ? allQuestions.filter((q) => only.includes(q.id)) : allQuestions;

  const pool = createPool(dbConfig.databaseUrl);
  // Mode tool : le serveur MCP de l'utilisateur, avec le mode de recherche du
  // run (sinon il prendrait celui du .env, et --mode ne servirait à rien).
  const mcp = ragMode === "tool" ? createMcpPool({ log: mcpLog, env: { RAG_SEARCH_MODE: mode } }) : null;
  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);
    const retrieve = createRetriever({ pool, embedder: createEmbeddingClient(embeddingConfig), defaultMode: mode });
    const llm = createLlmClient(appConfig.llm);

    const startedAt = new Date();
    const config: RunConfig = {
      date: startedAt.toISOString(),
      llm: { fournisseur: appConfig.llm.provider, modele: appConfig.llm.model, effort: EFFORT, temperature: null },
      embeddings: {
        fournisseur: embeddingConfig.provider,
        modele: embeddingConfig.model,
        dimension: embeddingConfig.dimension,
      },
      decoupage: { tokens_par_chunk: CHUNK_TARGET_TOKENS, recouvrement: CHUNK_OVERLAP_RATIO },
      k: DEFAULT_K,
      recherche:
        mode === "hybrid" ? { mode, candidats_par_recherche: HYBRID_CANDIDATES, rrf_k: RRF_K } : { mode },
      utilisateur: { id: user.id, groupes: user.groupes },
      rag: { mode: ragMode },
      commit: gitCommit(),
      sha256_prompt_systeme: sha256(ragMode === "tool" ? TOOL_SYSTEM_PROMPT : RAG_SYSTEM_PROMPT),
      sha256_questions: sha256(questionsText),
      documents: (await listDocuments(pool)).map((d) => ({ fichier: d.fileName, sha256: d.sha256, chunks: d.chunks })),
    };

    const runFile = `${RUNS_DIR}${runIdFromDate(startedAt)}.json`;
    await mkdir(RUNS_DIR, { recursive: true });
    const run: RunFile = { config, resultats: [] };
    console.log(
      `${questions.length} question(s) · ${config.llm.modele} (effort ${EFFORT}) · RAG ${ragMode} · ` +
        `recherche ${mode} · utilisateur ${user.id} · k=${config.k}`,
    );

    // Une question après l'autre : des appels parallèles se disputeraient les
    // quotas (Voyage : 3 requêtes/min sur ce compte) et rendraient les durées
    // incomparables.
    for (const [i, question] of questions.entries()) {
      const result =
        mcp === null
          ? await runQuestion(question, { retrieve, llm, userGroups: user.groupes })
          : await runToolQuestion(question, { llm, mcp, userId: user.id });
      run.resultats.push(result);
      // Écrit après chaque question : un run interrompu garde ce qu'il a fait.
      await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);

      // Jamais la question ni la réponse dans la console : seulement l'état.
      const status = result.erreur ? `✗ erreur : ${result.erreur.slice(0, 120)}` : "✓";
      const searches = result.recherches === undefined ? "" : `recherches ${result.recherches}  `;
      console.log(
        `[${String(i + 1).padStart(2)}/${questions.length}] ${question.id} ${question.type.padEnd(12)} ` +
          `${(result.duree_ms / 1000).toFixed(1).padStart(5)} s  ${searches}${status}`,
      );
    }

    if (mcp !== null) {
      const counts = run.resultats.map((r) => r.recherches ?? 0);
      const without = counts.filter((n) => n === 0).length;
      console.log(
        `\nsearch_documents : ${counts.reduce((a, b) => a + b, 0)} appel(s) ; ` +
          `${questions.length - without}/${questions.length} question(s) avec recherche, ${without} sans.`,
      );
    }

    await writeReport(runFile, run, allQuestions);
    const errors = run.resultats.filter((r) => r.erreur).length;
    const base = runFile.replace(/\.json$/, "");
    console.log(`\nRun écrit dans ${runFile}${errors > 0 ? ` (${errors} erreur(s))` : ""}`);
    console.log(`Rapport à noter : ${base}.md`);
    console.log(`Notes à saisir  : ${base}.notes.json`);
    return runIdFromDate(startedAt);
  } finally {
    await Promise.all([pool.end(), mcp?.close()]);
  }
}

/**
 * Une question : recherche, prompt, réponse. Toute erreur est capturée et
 * notée dans le résultat : une question qui échoue n'arrête pas le run.
 */
async function runQuestion(
  question: EvalQuestion,
  { retrieve, llm, userGroups }: { retrieve: Retrieve; llm: LlmClient; userGroups: readonly string[] },
): Promise<RunResult> {
  const startedAt = performance.now();
  const result: RunResult = {
    id: question.id,
    type: question.type,
    question: question.question,
    reponse_obtenue: null,
    sources_citees: [],
    chunks_recuperes: [],
    duree_ms: 0,
    erreur: null,
  };

  try {
    const chunks = await retrieve(question.question, { userGroups, k: DEFAULT_K });
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

/**
 * Mode tool : la question passe par la boucle d'outils de /chat, avec les
 * mêmes outils (maison + MCP) et le même prompt. On note en plus combien de
 * fois le modèle a cherché, et avec quelles questions.
 */
async function runToolQuestion(
  question: EvalQuestion,
  { llm, mcp, userId }: { llm: LlmClient; mcp: McpPool; userId: string },
): Promise<RunResult> {
  const startedAt = performance.now();
  const result: RunResult = {
    id: question.id,
    type: question.type,
    question: question.question,
    reponse_obtenue: null,
    sources_citees: [],
    chunks_recuperes: [],
    duree_ms: 0,
    erreur: null,
    recherches: 0,
    questions_recherche: [],
  };
  const searchQuestions: string[] = [];
  const failures: string[] = [];

  try {
    const searchResults = createSearchResults();
    const mcpTools = await loadMcpTools(mcp, userId, {
      formatResult: searchResults.format,
      timeoutMs: EVAL_SEARCH_TIMEOUT_MS,
    });
    const outcome = await runConversation({
      llm,
      tools: createToolRegistry([getCurrentDatetimeTool, calculateTool, ...mcpTools]),
      system: TOOL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: question.question }],
      userId,
      effort: EFFORT,
      emit: () => undefined,
      log: { info: () => undefined },
      onToolResult: ({ name, input }, toolResult) => {
        if (name !== SEARCH_TOOL_NAME) return;
        const asked = (input as { question?: unknown } | null)?.question;
        searchQuestions.push(typeof asked === "string" ? asked : "");
        if (!toolResult.ok) failures.push(toolResult.content.slice(0, 200));
      },
    });

    // Les extraits de toutes les recherches, chacun avec son rang dans la
    // recherche qui l'a trouvé : c'est ce rang que note le grader recherche.
    const excerpts = searchResults.excerpts;
    result.chunks_recuperes = excerpts.map((excerpt) => ({
      rang: excerpt.rank,
      fichier: excerpt.fileName,
      pages: pageRange(excerpt.pageStart, excerpt.pageEnd),
      score: Number(excerpt.score.toFixed(3)),
    }));
    result.reponse_obtenue = outcome.text;
    result.sources_citees = extractCitations(outcome.text, excerpts.length).map((index) => {
      const excerpt = excerpts[index - 1]!;
      return { index, fichier: excerpt.fileName, pages: pageRange(excerpt.pageStart, excerpt.pageEnd) };
    });
    if (!outcome.completed) result.erreur = "trop de tours d'outils sans réponse finale";
    else if (failures.length > 0) result.erreur = `recherche en échec : ${failures[0]}`;
  } catch (error) {
    result.erreur = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  result.recherches = searchQuestions.length;
  result.questions_recherche = searchQuestions;
  result.duree_ms = Math.round(performance.now() - startedAt);
  return result;
}

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

// Lancé directement (npm run eval:run) : on exécute. Importé par eval.ts : non.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  executeRun(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  });
}
