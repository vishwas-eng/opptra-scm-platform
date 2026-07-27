#!/usr/bin/env bash
# Run the whole platform locally WITHOUT Docker (macOS + Homebrew Postgres/Redis).
#   ./scripts/run-local.sh          start everything
#   ./scripts/run-local.sh stop     stop the api + worker
# Then open http://localhost:8080 and click "Dev login (local only)".
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
PIDDIR=".local"; mkdir -p "$PIDDIR"

stop() {
  for svc in api worker; do
    [ -f "$PIDDIR/$svc.pid" ] && kill "$(cat "$PIDDIR/$svc.pid")" 2>/dev/null || true
    rm -f "$PIDDIR/$svc.pid"
  done
  echo "stopped api + worker (Postgres/Redis left running — they're shared brew services)"
}
[ "${1:-}" = "stop" ] && { stop; exit 0; }

command -v psql >/dev/null || { echo "Postgres 16 not found — brew install postgresql@16"; exit 1; }
command -v redis-server >/dev/null || { echo "Redis not found — brew install redis"; exit 1; }
# .env is the PRODUCTION deploy config; local runs use .env.dev.local so the two never mix.
ENV_FILE=.env
[ -f .env.dev.local ] && ENV_FILE=.env.dev.local
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE missing — create it from .env.example"; exit 1; }
echo "▸ using $ENV_FILE"

echo "▸ ensuring Postgres + Redis are up…"
brew services start postgresql@16 >/dev/null 2>&1 || true
brew services start redis >/dev/null 2>&1 || true
sleep 2

echo "▸ ensuring database exists…"
psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='opptra'" | grep -q 1 || psql -d postgres -c "CREATE ROLE opptra LOGIN PASSWORD 'localdev';"
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='opptra'" | grep -q 1 || psql -d postgres -c "CREATE DATABASE opptra OWNER opptra;"

set -a; . "./$ENV_FILE"; set +a
echo "▸ migrating…"; node packages/core/src/migrate.js

stop  # clear any previous run
echo "▸ starting api + worker…"
nohup node apps/api/src/server.js    > "$PIDDIR/api.log"    2>&1 & echo $! > "$PIDDIR/api.pid"
nohup node apps/worker/src/worker.js > "$PIDDIR/worker.log" 2>&1 & echo $! > "$PIDDIR/worker.pid"
sleep 3
echo
echo "════════════════════════════════════════════════════════════"
echo "  Platform running →  http://localhost:8080"
echo "  Sign in with the  'Dev login (local only)'  button."
echo "  To run REAL automations: Admin tab → paste a Unicommerce JSESSIONID."
echo "  Logs: $PIDDIR/api.log · $PIDDIR/worker.log      Stop: ./scripts/run-local.sh stop"
echo "════════════════════════════════════════════════════════════"
