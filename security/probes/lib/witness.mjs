// Serveur témoin des sondes : il joue l'« attaquant » sur 127.0.0.1:9999.
// Il journalise chaque requête reçue dans security/probes/out/witness.log et
// renvoie un pixel transparent. Si une ligne apparaît, c'est que le
// navigateur a appelé une URL qu'il n'aurait jamais dû appeler.
//
// Usage (depuis chatbot/) : node security/probes/lib/witness.mjs
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PORT = 9999;
const OUT = fileURLToPath(new URL("../out/", import.meta.url));
const LOG = `${OUT}witness.log`;
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

mkdirSync(OUT, { recursive: true });

createServer((req, res) => {
  const line = `${new Date().toISOString()} ${req.method} ${req.url}`;
  console.log("HIT", line);
  appendFileSync(LOG, `${line}\n`);
  res.writeHead(200, { "content-type": "image/gif" }).end(PIXEL);
}).listen(PORT, "127.0.0.1", () => console.log(`Témoin sur http://127.0.0.1:${PORT} (journal : ${LOG})`));
