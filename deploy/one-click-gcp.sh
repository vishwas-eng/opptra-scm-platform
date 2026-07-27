#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Opptra SCM Platform — ONE-CLICK Google Cloud deploy
#
#  Prereqs (once):  gcloud auth login   &&   a GCP project with billing
#  Usage:           ./deploy/one-click-gcp.sh <PROJECT_ID>
#
#  Idempotent: safe to re-run — it creates what's missing and updates the rest.
#  What it does:
#    1. enables the Compute API
#    2. reserves a STATIC IP in asia-south1 (Mumbai) — this is the IP UC whitelists
#    3. opens firewall for 80/443
#    4. creates an e2-medium Debian-12 VM with Docker installed
#    5. uploads this repo + your .env to the VM
#    6. docker compose up -d --build   (postgres, redis, api, worker, caddy)
#    7. prints the URL and health status
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT_ID="${1:-${PROJECT_ID:-}}"
REGION="${REGION:-asia-south1}"
ZONE="${ZONE:-asia-south1-a}"
VM_NAME="${VM_NAME:-opptra-scm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
DISK_GB="${DISK_GB:-50}"
IP_NAME="${IP_NAME:-opptra-scm-ip}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

say()  { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$PROJECT_ID" ] || die "usage: ./deploy/one-click-gcp.sh <PROJECT_ID>"
command -v gcloud >/dev/null || die "gcloud CLI not installed"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "not logged in — run: gcloud auth login"

[ -f "$REPO_DIR/.env" ] || die "$REPO_DIR/.env missing — copy .env.example to .env and fill it in first"
# Fail fast on obviously incomplete .env (the server would refuse to boot anyway).
for key in POSTGRES_PASSWORD JWT_SECRET GOOGLE_CLIENT_ID UC_BASE_URL; do
  grep -qE "^${key}=.+" "$REPO_DIR/.env" || die ".env is missing a value for ${key}"
done

say "Using project $PROJECT_ID (region $REGION, zone $ZONE)"
gcloud config set project "$PROJECT_ID" --quiet >/dev/null

say "1/7 Enabling Compute Engine API (no-op if already enabled)…"
gcloud services enable compute.googleapis.com --quiet
ok "API enabled"

say "2/7 Reserving static IP '$IP_NAME' in $REGION…"
if ! gcloud compute addresses describe "$IP_NAME" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$IP_NAME" --region "$REGION" --quiet
fi
STATIC_IP=$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')
ok "Static IP: $STATIC_IP   ← give this to Unicommerce for whitelisting"

# HTTPS is MANDATORY: Google Sign-In refuses insecure origins and browsers drop
# Secure cookies over plain HTTP (login would silently loop). If .env still has the
# ":80" placeholder, switch it to <IP>.sslip.io — a public DNS trick that resolves
# to the IP, letting Caddy issue a real Let's Encrypt certificate with zero DNS setup.
if grep -qE '^SITE_ADDRESS=:80$' "$REPO_DIR/.env"; then
  SSLIP="${STATIC_IP}.sslip.io"
  say "   .env has no domain — enabling automatic HTTPS via ${SSLIP}"
  sed -i.bak -e "s|^SITE_ADDRESS=:80$|SITE_ADDRESS=${SSLIP}|" \
             -e "s|^PUBLIC_URL=.*$|PUBLIC_URL=https://${SSLIP}|" "$REPO_DIR/.env"
  rm -f "$REPO_DIR/.env.bak"
  ok "SITE_ADDRESS=${SSLIP} · PUBLIC_URL=https://${SSLIP} (swap in scm.opptra.com later)"
fi
SITE=$(grep -E '^SITE_ADDRESS=' "$REPO_DIR/.env" | cut -d= -f2)

say "3/7 Firewall for HTTP/HTTPS…"
if ! gcloud compute firewall-rules describe opptra-scm-web >/dev/null 2>&1; then
  gcloud compute firewall-rules create opptra-scm-web \
    --allow tcp:80,tcp:443 --target-tags opptra-scm --quiet
fi
ok "Firewall ready"

say "4/7 VM '$VM_NAME' ($MACHINE_TYPE, ${DISK_GB}GB, Debian 12)…"
if ! gcloud compute instances describe "$VM_NAME" --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
    --address "$STATIC_IP" \
    --tags opptra-scm \
    --quiet
  say "   waiting for SSH to come up…"
  for i in $(seq 1 30); do
    gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command 'true' -- -o ConnectTimeout=5 >/dev/null 2>&1 && break
    sleep 10
  done
fi
ok "VM ready"

say "5/7 Installing Docker on the VM (no-op if present)…"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command '
  set -e
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
  fi
  sudo mkdir -p /opt/opptra-scm && sudo chown "$USER" /opt/opptra-scm
'
ok "Docker ready"

say "6/7 Uploading code + .env…"
TARBALL=$(mktemp /tmp/opptra-scm-XXXX.tar.gz)
# COPYFILE_DISABLE stops macOS tar from embedding "._foo" AppleDouble metadata files -
# one of those next to a migration (still ends in .sql, sorts before it) crashes the
# migration runner with a binary-garbage SQL statement on first boot.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$REPO_DIR" \
  --exclude node_modules --exclude .git --exclude '.env.*' \
  --exclude '._*' \
  .
gcloud compute scp "$TARBALL" "$VM_NAME:/tmp/opptra-scm.tar.gz" --zone "$ZONE" --quiet
rm -f "$TARBALL"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command '
  set -e
  cd /opt/opptra-scm
  tar -xzf /tmp/opptra-scm.tar.gz && rm /tmp/opptra-scm.tar.gz
'
ok "Code uploaded"

say "7/7 Building and starting the stack (first build takes ~2-3 min)…"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command '
  set -e
  cd /opt/opptra-scm
  sudo docker compose up -d --build
  sleep 8
  sudo docker compose ps
'
ok "Stack is up"

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Platform URL : https://$SITE   (open it and sign in)"
echo "  Static IP    : $STATIC_IP  ← send to Unicommerce for whitelisting"
echo "  Health       : https://$SITE/healthz"
echo
echo "  Next steps:"
echo "   1. In GCP Console → Credentials, add https://$SITE to the"
echo "      OAuth client's Authorized JavaScript origins."
echo "   2. (Later) point scm.opptra.com → $STATIC_IP, set SITE_ADDRESS=scm.opptra.com"
echo "      and PUBLIC_URL in .env, re-run ./deploy/update.sh — HTTPS re-issues automatically."
echo "   3. Sign in with your @opptra.com account (first ADMIN_EMAILS user = admin),"
echo "      open Admin tab, paste a fresh UC JSESSIONID → session goes ALIVE."
echo "════════════════════════════════════════════════════════════════"
