#!/usr/bin/env bash
# Redeploy after code or .env changes:  ./deploy/update.sh <PROJECT_ID>
set -euo pipefail

PROJECT_ID="${1:-${PROJECT_ID:-}}"
ZONE="${ZONE:-asia-south1-a}"
VM_NAME="${VM_NAME:-opptra-scm}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ -n "$PROJECT_ID" ] || { echo "usage: ./deploy/update.sh <PROJECT_ID>"; exit 1; }

# Build the SPA and validate the release BEFORE touching the VM. The image builds the
# web app too, but building here means a broken bundle fails on the laptop rather than
# after the running containers have already been replaced.
echo "→ building web app"
( cd "$REPO_DIR" && npm run build:web >/dev/null )
echo "→ preflight"
node "$REPO_DIR/scripts/preflight.js" "$REPO_DIR/.env.production" || {
  echo "preflight failed — aborting deploy"; exit 1;
}

gcloud config set project "$PROJECT_ID" --quiet >/dev/null

# Fail early and clearly if the gcloud session has expired, rather than half-way
# through with a confusing scp error.
gcloud auth print-access-token >/dev/null 2>&1 || {
  echo "gcloud auth has expired — run: gcloud auth login"; exit 1;
}

TARBALL=$(mktemp /tmp/opptra-scm-XXXX.tar.gz)
# COPYFILE_DISABLE stops macOS tar from embedding "._foo" AppleDouble metadata files -
# one of those next to a migration (still ends in .sql, sorts before it) crashes the
# migration runner with a binary-garbage SQL statement on boot.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$REPO_DIR" \
  --exclude node_modules --exclude .git \
  --exclude '.env' --exclude '.env.*' --exclude '._*' .
gcloud compute scp "$TARBALL" "$VM_NAME:/tmp/opptra-scm.tar.gz" --zone "$ZONE" --quiet
rm -f "$TARBALL"

gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command '
  set -e
  cd /opt/opptra-scm
  tar -xzf /tmp/opptra-scm.tar.gz && rm /tmp/opptra-scm.tar.gz
  sudo docker compose up -d --build
  sleep 5
  sudo docker compose ps
  curl -fsS http://localhost/healthz && echo
'
echo "✓ redeployed"
