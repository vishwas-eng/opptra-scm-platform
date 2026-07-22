#!/usr/bin/env bash
# Zip the browser extensions into the web app's downloads folder.
# Run locally before commit, and in the Docker build so images are self-contained.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/public/downloads"
mkdir -p "$OUT"

build() {
  local src="$1" name="$2"
  ( cd "$ROOT/extensions/$src" && find . -name .DS_Store -delete 2>/dev/null || true
    rm -f "$OUT/$name.zip"
    zip -qr "$OUT/$name.zip" . )
  echo "  built $name.zip"
}

build session-helper  opptra-session-helper
build bulk-download    bulk-download-extension
echo "✓ extensions packaged into apps/web/public/downloads/"
