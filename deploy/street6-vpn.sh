#!/usr/bin/env bash
# 6th Street VPN helper — documents how the GCP VM (or a jump host) may connect.
# Does NOT print secrets. Reads STREET6_VPN_* from /opt/opptra-scm/.env if present.
#
# Reality check: FortiClient / SSL VPN often cannot run headless on the e2-medium
# app VM. If connect fails, use Path B in docs/connectors/6thstreet.md (operator
# laptop on VPN downloads picklist/invoice/label; worker only emails).
set -euo pipefail

ENV_FILE="${STREET6_ENV_FILE:-/opt/opptra-scm/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # Only load STREET6_VPN_* lines
  eval "$(grep -E '^STREET6_VPN_(NAME|HOST|USER|PASS)=' "$ENV_FILE" | sed 's/\r$//' || true)"
  set +a
fi

HOST="${STREET6_VPN_HOST:-10.61.1.11}"
USER="${STREET6_VPN_USER:-}"
NAME="${STREET6_VPN_NAME:-6thStreet-OMS}"

echo "6th Street VPN profile: name=${NAME} host=${HOST} user=${USER:+set}${USER:-missing}"
echo "Pass configured: $([[ -n "${STREET6_VPN_PASS:-}" ]] && echo yes || echo no)"

if [[ -z "${STREET6_VPN_USER:-}" || -z "${STREET6_VPN_PASS:-}" ]]; then
  echo "Missing STREET6_VPN_USER / STREET6_VPN_PASS in env — abort."
  exit 2
fi

if command -v openfortivpn >/dev/null 2>&1; then
  echo "Attempting openfortivpn (interactive OTP may still be required)…"
  # Password via stdin; do not echo.
  exec openfortivpn "$HOST" -u "$STREET6_VPN_USER" -p "$STREET6_VPN_PASS"
fi

if command -v forticlient >/dev/null 2>&1; then
  echo "forticlient binary found — use GUI/profile '${NAME}' on a desktop jump host."
  echo "This script will not auto-drive FortiClient GUI."
  exit 3
fi

echo "No openfortivpn/forticlient on this host."
echo "Path B: connect VPN on an operator laptop, capture HAR + files, use SCM dry-run email with injected artifacts."
exit 4
