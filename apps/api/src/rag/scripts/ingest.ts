// npm run ingest — ingère les PDF de data/pdfs/ dans la base.
// Idempotent : un fichier inchangé (même sha256) est ignoré, un fichier
// modifié est entièrement réingéré.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "../../config.js";
import { loadDatabaseConfig, loadEmbeddingConfig, PDF_DIR } from "../config.js";
import { createPool } from "../db/pool.js";
import { getDocumentHashes, replaceDocument } from "../db/repository.js";
import { assertEmbeddingDimension } from "../db/schema.js";
import { splitPdf } from "../document.js";
import { createEmbeddingClient, type EmbeddingClient } from "../embeddings/index.js";

type Outcome = "ingested" | "skipped" | "failed";

async function main(): Promise<void> {
  const dbConfig = loadDatabaseConfig();
  const embedder = createEmbeddingClient(loadEmbeddingConfig());
  const pool = createPool(dbConfig.databaseUrl);

  // Ctrl+C : on annule proprement les appels en cours.
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());

  try {
    await assertEmbeddingDimension(pool, dbConfig.embeddingDimension);

    const files = await listPdfs(PDF_DIR);
    const known = await getDocumentHashes(pool);
    console.log(`${files.length} PDF trouvé(s) dans ${PDF_DIR}`);

    const outcomes: Record<Outcome, number> = { ingested: 0, skipped: 0, failed: 0 };
    const started = performance.now();

    for (const fileName of files) {
      if (abort.signal.aborted) break;
      const outcome = await ingestFile(fileName, known.get(fileName), { pool, embedder, signal: abort.signal });
      outcomes[outcome]++;
    }

    const absent = [...known.keys()].filter((name) => !files.includes(name));
    for (const name of absent) {
      console.warn(`⚠ ${name} : présent en base mais plus dans le dossier (conservé).`);
    }

    console.log(
      `\nTerminé en ${seconds(started)} : ${outcomes.ingested} ingéré(s), ` +
        `${outcomes.skipped} inchangé(s), ${outcomes.failed} en échec.`,
    );
    if (outcomes.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

interface IngestDeps {
  pool: ReturnType<typeof createPool>;
  embedder: EmbeddingClient;
  signal: AbortSignal;
}

/**
 * Traite un fichier. Les logs ne contiennent que des métadonnées (nom,
 * pages, chunks, tokens, durée), jamais le texte du document.
 */
async function ingestFile(fileName: string, knownHash: string | undefined, deps: IngestDeps): Promise<Outcome> {
  const started = performance.now();
  try {
    const bytes = await readFile(path.join(PDF_DIR, fileName));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 === knownHash) {
      console.log(`= ${fileName} : inchangé, ignoré`);
      return "skipped";
    }

    // 1. Découpage (local, rapide).
    const { pageCount, chunks } = await splitPdf(bytes);
    if (chunks.length === 0) {
      console.warn(`⚠ ${fileName} : aucun texte extrait (PDF scanné ?)`);
    }

    // 2. Embeddings (réseau, lent) — avant d'ouvrir la transaction.
    const { vectors, totalTokens } = await deps.embedder.embedDocuments(
      chunks.map((chunk) => chunk.content),
      { signal: deps.signal },
    );

    // 3. Écriture (transaction courte).
    await replaceDocument(deps.pool, { fileName, sha256, chunks, embeddings: vectors });

    const verb = knownHash === undefined ? "nouveau" : "modifié, réingéré";
    console.log(
      `+ ${fileName} : ${verb} · ${pageCount} pages · ${chunks.length} chunks · ` +
        `${totalTokens} tokens d'embedding · ${seconds(started)}`,
    );
    return "ingested";
  } catch (error) {
    // Le fichier en échec n'empêche pas de traiter les suivants ; sa version
    // précédente en base (s'il y en a une) reste intacte grâce à la transaction.
    console.error(`✗ ${fileName} : ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/** Chemins relatifs à `dir` de tous les .pdf, sous-dossiers compris, triés. */
async function listPdfs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

function seconds(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)} s`;
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
