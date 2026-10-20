#!/usr/bin/env bash
# Étape 3 (OWASP LLM01) — dépose et ingère les deux PDF de sonde pour le groupe
# tech (utilisateur de test : bruno), ou nettoie tout.
#
#   ./setup.sh         génère le PDF, le dépose, l'ajoute à l'ACL, ingère
#   ./setup.sh clean   retire le PDF, restaure l'ACL, supprime le document de la base
#
# Ne touche que des DONNÉES (data/pdfs/ et acl.json), sauvegardées avant.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PDF_DIR="$ROOT/apps/api/data/pdfs"
ACL="$PDF_DIR/acl.json"
BACKUP="$HERE/../out/acl.json.bak"
NAMES=("sonde-injection.pdf" "sonde-injection-subtile.pdf")

if [ "${1:-}" = "clean" ]; then
  [ -f "$BACKUP" ] && cp "$BACKUP" "$ACL" && rm "$BACKUP" && echo "acl.json restauré"
  for NAME in "${NAMES[@]}"; do rm -f "$PDF_DIR/$NAME" && echo "$NAME retiré de data/pdfs/"; done
  # ingest garde un document absent du dossier : on le supprime de la base (chunks en cascade).
  ( cd "$ROOT/apps/api" && node --env-file=.env -e '
    const pg = require("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    pool.query("DELETE FROM documents WHERE file_name = ANY($1)", [process.argv.slice(1)])
      .then((r) => console.log(`base : ${r.rowCount} document(s) supprimé(s)`))
      .finally(() => pool.end());
  ' "${NAMES[@]}" )
  exit 0
fi

node "$HERE/make-pdf.mjs"
for NAME in "${NAMES[@]}"; do cp "$HERE/$NAME" "$PDF_DIR/$NAME"; done
mkdir -p "$(dirname "$BACKUP")"
[ -f "$BACKUP" ] || cp "$ACL" "$BACKUP"
node -e '
  const fs = require("fs");
  const [path, ...names] = process.argv.slice(1);
  const acl = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const name of names) acl[name] = ["tech"];
  fs.writeFileSync(path, JSON.stringify(acl, null, 2) + "\n");
  console.log("acl.json :", JSON.stringify(acl));
' "$ACL" "${NAMES[@]}"
( cd "$ROOT" && npm run --silent ingest )
