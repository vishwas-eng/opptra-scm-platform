#!/usr/bin/env bash
# Redeploy after code or .env changes:  ./deploy/update.sh <PROJECT_ID>
set -euo pipefail

PROJECT_ID="${1:-${PROJECT_ID:-}}"
ZONE="${ZONE:-asia-south1-a}"
VM_NAME="${VM_NAME:-opptra-scm}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ -n "$PROJECT_ID" ] || { echo "usage: ./deploy/update.sh <PROJECT_ID>"; exit 1; }
gcloud config set project "$PROJECT_ID" --quiet >/dev/null

TARBALL=$(mktemp /tmp/opptra-scm-XXXX.tar.gz)
# COPYFILE_DISABLE stops macOS tar from embedding "._foo" AppleDouble metadata files -
# one of those next to a migration (still ends in .sql, sorts before it) crashes the
# migration runner with a binary-garbage SQL statement on boot.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$REPO_DIR" --exclude node_modules --exclude .git --exclude '.env.*' --exclude '._*' .
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
