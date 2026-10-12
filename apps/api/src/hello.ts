import { ConfigError, loadConfig } from "./config.js";
import { createLlmClient } from "./llm/index.js";

const QUESTION = "Explique en trois phrases ce qu'est un monorepo npm.";

try {
  const config = loadConfig();
  const llm = createLlmClient(config.llm);

  // Ctrl+C annule la génération en cours plutôt que de tuer le process brutalement.
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  console.log(`> ${QUESTION}\n`);

  // Sans outils déclarés, le modèle n'émet que des événements "text".
  for await (const event of llm.streamChat({
    messages: [{ role: "user", content: QUESTION }],
    signal: controller.signal,
  })) {
    if (event.type === "text") process.stdout.write(event.text);
  }
  process.stdout.write("\n");
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n[config] ${error.message}\n`);
  } else {
    console.error("\n[hello] Échec :", error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
