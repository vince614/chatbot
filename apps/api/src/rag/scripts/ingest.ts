// npm run ingest — ingère les PDF de data/pdfs/ dans la base, puis applique
// les droits de data/pdfs/acl.json.
// Idempotent : un fichier inchangé (même sha256) est ignoré, un fichier
// modifié est entièrement réingéré. Les droits, eux, sont réappliqués à chaque
// fois : changer acl.json ne modifie pas le sha256 des PDF.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type Acl, loadAcl } from "@chatbot/rag/acl";
import { createPool } from "@chatbot/rag/db/pool";
import { applyAcl, getDocumentHashes, replaceDocument } from "@chatbot/rag/db/repository";
import { assertEmbeddingDimension } from "@chatbot/rag/db/schema";
import { splitPdf } from "@chatbot/rag/document";
import { createEmbeddingClient, type EmbeddingClient } from "@chatbot/rag/embeddings/index";

import { ACL_FILE, ConfigError, loadDatabaseConfig, loadEmbeddingConfig, PDF_DIR } from "../../config.js";

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

    // L'ACL est lue en premier : invalide, rien n'est ingéré ni modifié.
    const acl = await loadAcl(ACL_FILE);
    const files = await listPdfs(PDF_DIR);
    warnAboutAcl(acl, files);
    const known = await getDocumentHashes(pool);
    console.log(`${files.length} PDF trouvé(s) dans ${PDF_DIR}`);

    const outcomes: Record<Outcome, number> = { ingested: 0, skipped: 0, failed: 0 };
    const started = performance.now();

    for (const fileName of files) {
      if (abort.signal.aborted) break;
      const outcome = await ingestFile(fileName, known.get(fileName), {
        pool,
        embedder,
        allowedGroups: acl.get(fileName) ?? [],
        signal: abort.signal,
      });
      outcomes[outcome]++;
    }

    const absent = [...known.keys()].filter((name) => !files.includes(name));
    for (const name of absent) {
      console.warn(`⚠ ${name} : présent en base mais plus dans le dossier (conservé).`);
    }

    // Les droits de tous les documents en base, inchangés compris.
    const changed = await applyAcl(pool, acl);
    for (const { fileName, allowedGroups } of changed) {
      console.log(`🔒 ${fileName} : droits → ${allowedGroups.length > 0 ? allowedGroups.join(", ") : "personne"}`);
    }
    console.log(`Droits : ${changed.length} document(s) mis à jour, les autres étaient déjà à jour.`);

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
  allowedGroups: string[];
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
    await replaceDocument(deps.pool, {
      fileName,
      sha256,
      chunks,
      embeddings: vectors,
      allowedGroups: deps.allowedGroups,
    });

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

/**
 * Signale les incohérences de l'ACL sans bloquer : un PDF sans entrée (il
 * sera invisible, c'est voulu mais rarement souhaité) et une entrée sans PDF
 * (faute de frappe probable dans le nom).
 */
function warnAboutAcl(acl: Acl, files: string[]): void {
  for (const file of files) {
    const groups = acl.get(file);
    if (!groups || groups.length === 0) console.warn(`⚠ ${file} : aucun groupe dans ${ACL_FILE}, visible par personne.`);
  }
  for (const name of acl.keys()) {
    if (!files.includes(name)) console.warn(`⚠ acl.json cite « ${name} », absent de data/pdfs/ (faute de frappe ?).`);
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
