#!/usr/bin/env bash
# Huckleberry build script (v0.3.1)
# Produces the Firefox package, the Chrome/Edge package, and a source archive.
# No dependencies beyond bash, zip and (optionally) node/python3 for checks.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VERSION="$(grep -m1 '"version"' manifest.json | sed 's/[^0-9.]//g')"
DIST="$ROOT/dist"
STAGE="$ROOT/.stage"

SHARED=(background.js sidebar ui options content ai icons README.md LICENSE CHANGELOG.md PRIVACY.md SECURITY.md docs)

say() { printf '\033[1;35m•\033[0m %s\n' "$1"; }

say "Huckleberry v$VERSION"
rm -rf "$DIST" "$STAGE"
mkdir -p "$DIST"

# ---------------------------------------------------------------- checks
if command -v node >/dev/null 2>&1; then
  say "Checking JavaScript syntax"
  for f in background.js sidebar/sidebar.js options/options.js content/*.js ai/*.js; do
    node --check "$f"
  done
else
  say "node not found — skipping syntax check"
fi

if command -v python3 >/dev/null 2>&1; then
  say "Validating manifests"
  python3 -c "import json,sys;[json.load(open(f)) for f in ('manifest.json','manifest.chrome.json')]"
fi

# ---------------------------------------------------------------- firefox
say "Packaging Firefox build"
mkdir -p "$STAGE/firefox"
cp -R "${SHARED[@]}" "$STAGE/firefox/"
cp manifest.json "$STAGE/firefox/manifest.json"
(cd "$STAGE/firefox" && zip -qr9 "$DIST/huckleberry-firefox.zip" .)

# ---------------------------------------------------------------- chrome
say "Packaging Chrome / Edge build"
mkdir -p "$STAGE/chrome"
cp -R "${SHARED[@]}" "$STAGE/chrome/"
cp manifest.chrome.json "$STAGE/chrome/manifest.json"
(cd "$STAGE/chrome" && zip -qr9 "$DIST/huckleberry-chrome.zip" .)

# ---------------------------------------------------------------- source
say "Packaging source archive"
zip -qr9 "$DIST/huckleberry-$VERSION-source.zip" . \
  -x "dist/*" ".stage/*" ".git/*" "*.DS_Store" "node_modules/*"

rm -rf "$STAGE"

say "Done:"
ls -lh "$DIST" | tail -n +2
