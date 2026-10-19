#!/usr/bin/env bash
# Attaque 1 - Injection indirecte par document (OWASP LLM01).
#
# Enchaine : generation du PDF piege -> depot dans data/pdfs/ + droits tech
# -> ingestion -> trois questions + scenario resume.
#
# NE MODIFIE PAS le code de l'application. Touche seulement des DONNEES
# (data/pdfs/ et acl.json), sauvegardees puis restaurables via : ./run.sh clean
#
# Prerequis : API lancee sur http://127.0.0.1:3000, Postgres up, cles API.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PDF_DIR="$ROOT/apps/api/data/pdfs"
ACL="$PDF_DIR/acl.json"
ACL_BACKUP="$HERE/acl.json.bak"

clean() {
  echo "== Nettoyage =="
  [ -f "$ACL_BACKUP" ] && cp "$ACL_BACKUP" "$ACL" && echo "acl.json restaure"
  rm -f "$PDF_DIR/piege.pdf" && echo "piege.pdf retire de data/pdfs/"
  echo "Note : le document reste en base tant que vous ne relancez pas 'npm run ingest'"
  echo "       (ingest conserve un document absent du dossier). Pour l'oter de la base,"
  echo "       supprimez-le cote SQL ou reinitialisez la base."
}

if [ "${1:-}" = "clean" ]; then clean; exit 0; fi

echo "== 1. Generation de piege.pdf =="
node "$HERE/make-pdf.mjs"

echo "== 2. Depot dans data/pdfs/ + droits groupe tech =="
cp "$HERE/piege.pdf" "$PDF_DIR/piege.pdf"
[ -f "$ACL_BACKUP" ] || cp "$ACL" "$ACL_BACKUP"   # sauvegarde unique de l'ACL d'origine
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const acl = JSON.parse(fs.readFileSync(p, "utf8"));
  acl["piege.pdf"] = ["tech"];
  fs.writeFileSync(p, JSON.stringify(acl, null, 2) + "\n");
  console.log("acl.json ->", JSON.stringify(acl));
' "$ACL"

echo "== 3. Ingestion (npm run ingest) =="
( cd "$ROOT" && npm run --silent ingest )

echo "== 4. Attaque : questions + scenario resume =="
( cd "$ROOT" && node "$HERE/attack.mjs" )

echo
echo "Pour restaurer l'etat initial des donnees : $HERE/run.sh clean"
