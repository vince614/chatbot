// Pilote de navigateur des sondes, sans dépendance : il lance un Chromium
// (Brave ou Chrome) sans interface, sur un profil jetable, et lui parle par
// le protocole DevTools (CDP) — exactement ce qu'utilise l'onglet Console et
// l'onglet Réseau des DevTools.
//
// Il ouvre une page, attend qu'elle soit chargée, y exécute un script de
// sonde (comme si on le collait dans la console), puis rapporte :
//  - les messages de console (dont les violations CSP) ;
//  - les requêtes réseau émises par la page (ce que montre l'onglet Réseau).
//
// Usage (depuis chatbot/) :
//   node security/probes/lib/navigateur.mjs <url> <script-de-sonde.js> [attente-ms]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, scriptPath, waitArg] = process.argv.slice(2);
if (!url || !scriptPath) {
  console.error("Usage : node navigateur.mjs <url> <script.js> [attente-ms]");
  process.exit(2);
}
const WAIT_MS = Number(waitArg ?? 3000);
const PORT = 9333;
const BROWSERS = [
  process.env["PROBE_BROWSER"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
const binary = BROWSERS.find((path) => existsSync(path));
if (!binary) {
  console.error("Aucun Chromium trouvé (PROBE_BROWSER=<chemin> pour en indiquer un).");
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "sonde-"));
const browser = spawn(
  binary,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // 1. Attendre que le navigateur ouvre son port DevTools, puis trouver l'onglet.
  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json`)
      .then((r) => r.json())
      .then((list) => list.find((t) => t.type === "page"))
      .catch(() => undefined);
  }
  if (!target) throw new Error("Le navigateur n'a pas ouvert son port DevTools.");

  // 2. Une petite couche requête/réponse au-dessus du WebSocket CDP.
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  // 3. Ce qu'on observe : console, journal du navigateur (CSP), requêtes réseau.
  const consoleLines = [];
  const requests = [];
  listeners.push(({ method, params }) => {
    if (method === "Runtime.consoleAPICalled") {
      consoleLines.push(`[console.${params.type}] ${params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (method === "Runtime.exceptionThrown") {
      consoleLines.push(`[exception] ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    } else if (method === "Log.entryAdded") {
      consoleLines.push(`[navigateur:${params.entry.level}] ${params.entry.text}`);
    } else if (method === "Network.requestWillBeSent") {
      requests.push(`${params.request.method} ${params.request.url}`);
    } else if (method === "Network.loadingFailed" && params.blockedReason) {
      requests.push(`  ↳ bloquée par le navigateur (${params.blockedReason})`);
    }
  });
  await Promise.all([send("Runtime.enable"), send("Log.enable"), send("Network.enable"), send("Page.enable")]);

  // 4. Charger la page, puis exécuter la sonde comme depuis la console.
  await send("Page.navigate", { url });
  await sleep(2500);
  const probe = readFileSync(scriptPath, "utf8");
  const evaluation = await send("Runtime.evaluate", { expression: probe, awaitPromise: true });
  if (evaluation.result?.exceptionDetails) {
    consoleLines.push(`[exception sonde] ${evaluation.result.exceptionDetails.exception?.description}`);
  }
  await sleep(WAIT_MS);

  // 5. Le DOM du dernier message, pour voir ce qui a été rendu.
  const dom = await send("Runtime.evaluate", {
    expression: "document.querySelector('.bubble--assistant:last-of-type .bubble__markdown')?.innerHTML ?? '(aucun message assistant)'",
    returnByValue: true,
  });

  console.log("=== Console ===");
  console.log(consoleLines.join("\n") || "(rien)");
  console.log("\n=== Réseau (hors fichiers du serveur de dev) ===");
  console.log(requests.filter((r) => !/\/(src|node_modules|@vite|@react-refresh|@fs)\//.test(r)).join("\n") || "(rien)");
  console.log("\n=== DOM du dernier message assistant ===");
  console.log(dom.result?.result?.value);
  ws.close();
} finally {
  browser.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
