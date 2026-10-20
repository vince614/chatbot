// npm run mcp:probe -- --user <id> ["ma question"] [--k 3]
// Le client MCP de l'API, sans le modèle : démarre le serveur MCP de
// l'utilisateur, affiche les outils tels que l'agent les verra (maison et
// MCP), puis appelle search_documents comme outil LangChain.
import { parseArgs } from "node:util";

import { loadUsers, requireUser } from "@chatbot/rag/users";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

import { ConfigError, loadMcpTransport, USERS_FILE } from "../config.js";
import { calculateTool, getCurrentDatetimeTool } from "../tools/index.js";
import { createMcpPool, loadMcpTools, MCP_TOOL_PREFIX, type McpLogger } from "./index.js";

const DEFAULT_QUESTION = "Quelles sont les règles du télétravail ?";

/** Les logs du pool sur stderr, pour ne pas les mêler au résultat. */
const log: McpLogger = {
  info: (details, message) => console.error(`  · ${message} ${JSON.stringify(details)}`),
  warn: (details, message) => console.error(`  ! ${message} ${JSON.stringify(details)}`),
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { user: { type: "string" }, k: { type: "string", default: "3" } },
  });
  const user = await requireUser(USERS_FILE, values.user);
  const question = positionals.join(" ").trim() || DEFAULT_QUESTION;

  // MCP_TRANSPORT : un sous-processus (stdio) ou une session sur le serveur HTTP.
  const transport = loadMcpTransport(log);
  console.log(`Transport MCP : ${transport.kind}${transport.kind === "http" ? ` (${transport.url.href})` : ""}\n`);
  const pool = createMcpPool({ log, transport });
  try {
    // 1. Démarrage du serveur et liste des outils : le premier appel paie le démarrage.
    let startedAt = performance.now();
    const mcpTools = await loadMcpTools(pool, user.id);
    console.log(`Outils MCP chargés pour ${user.id} en ${Math.round(performance.now() - startedAt)} ms.\n`);

    // 2. Les outils tels que /chat les donnera à l'agent : outils maison + outils MCP.
    const tools: StructuredToolInterface[] = [getCurrentDatetimeTool, calculateTool, ...mcpTools];
    console.log("Outils vus par le modèle :");
    for (const tool of tools) {
      const origin = tool.name.startsWith(MCP_TOOL_PREFIX) ? "MCP   " : "maison";
      const schema = toJsonSchema(tool.schema) as { properties?: object };
      console.log(`  [${origin}] ${tool.name}(${Object.keys(schema.properties ?? {}).join(", ")})`);
      console.log(`           ${tool.description.split("\n")[0]}`);
    }

    // 3. Un appel, comme le ferait la boucle d'outils. Le serveur tourne déjà : plus rapide.
    const name = `${MCP_TOOL_PREFIX}search_documents`;
    const input = { question, k: Number(values.k) };
    console.log(`\nAppel de ${name} ${JSON.stringify(input)} :\n`);
    startedAt = performance.now();
    const search = tools.find((tool) => tool.name === name)!;
    let ok = true;
    try {
      console.log(String(await search.invoke(input)));
    } catch (error) {
      ok = false;
      console.log(error instanceof Error ? error.message : String(error));
    }
    console.log(`\n→ ${ok ? "ok" : "erreur"} en ${Math.round(performance.now() - startedAt)} ms`);
  } finally {
    // Sans cela, le sous-processus garderait le script en vie.
    await pool.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
