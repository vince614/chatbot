// npm run mcp:probe -- --user <id> ["ma question"] [--k 3]
// Le client MCP de l'API, sans le modèle : démarre le serveur MCP de
// l'utilisateur, affiche les outils tels que le registre les voit (maison et
// MCP), puis appelle search_documents à travers le registre.
import { parseArgs } from "node:util";

import { loadUsers, requireUser } from "@chatbot/rag/users";

import { ConfigError, loadMcpTransport, USERS_FILE } from "../config.js";
import { calculateTool, createToolRegistry, getCurrentDatetimeTool } from "../tools/index.js";
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

    // 2. Le registre tel que /chat le construira : outils maison + outils MCP.
    const registry = createToolRegistry([getCurrentDatetimeTool, calculateTool, ...mcpTools]);
    console.log("Outils vus par le modèle :");
    for (const tool of registry.list()) {
      const origin = tool.name.startsWith(MCP_TOOL_PREFIX) ? "MCP   " : "maison";
      const properties = Object.keys((tool.inputSchema["properties"] as object | undefined) ?? {});
      console.log(`  [${origin}] ${tool.name}(${properties.join(", ")})`);
      console.log(`           ${tool.description.split("\n")[0]}`);
    }

    // 3. Un appel, comme le ferait la boucle d'outils. Le serveur tourne déjà : plus rapide.
    const name = `${MCP_TOOL_PREFIX}search_documents`;
    const input = { question, k: Number(values.k) };
    console.log(`\nAppel de ${name} ${JSON.stringify(input)} :\n`);
    startedAt = performance.now();
    const result = await registry.execute(name, input);
    console.log(result.content);
    console.log(`\n→ ${result.ok ? "ok" : "erreur"} en ${Math.round(performance.now() - startedAt)} ms`);
  } finally {
    // Sans cela, le sous-processus garderait le script en vie.
    await pool.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
