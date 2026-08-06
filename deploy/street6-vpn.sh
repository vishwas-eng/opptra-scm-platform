#!/usr/bin/env bash
# 6th Street OMS tunnel.
#
# The FortiClient profile is IPsec, not SSL-VPN: gateway 37.76.253.34 (public),
# pre-shared key, XAuth user OMS999. That distinction matters because openfortivpn
# only speaks SSL-VPN and can never connect to this, which is why the old version of
# this script could not work regardless of credentials.
#
# On Linux the equivalent is strongSwan (IKEv1 + PSK + XAuth). This script writes the
# config and brings the tunnel up.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/opptra-scm/.env}"
val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }

HOST="$(val STREET6_VPN_HOST)";  HOST="${HOST:-37.76.253.34}"
USER_="$(val STREET6_VPN_USER)"; PASS="$(val STREET6_VPN_PASS)"
PSK="$(val STREET6_VPN_PSK)";    MODE="$(val STREET6_VPN_MODE)"; MODE="${MODE:-ipsec}"

echo "gateway : $HOST"
echo "mode    : $MODE"
echo "user    : ${USER_:-(unset)}"
echo "psk     : $([ -n "$PSK" ] && echo set || echo MISSING)"

[ -n "$USER_" ] && [ -n "$PASS" ] || { echo "ERROR: set STREET6_VPN_USER and STREET6_VPN_PASS in $ENV_FILE"; exit 2; }

if [ "$MODE" = "ssl" ]; then
  command -v openfortivpn >/dev/null || { echo "ERROR: openfortivpn not installed"; exit 3; }
  exec openfortivpn "$HOST" -u "$USER_" -p "$PASS"
fi

# ---- IPsec (what the FortiClient profile actually uses) ----
[ -n "$PSK" ] || { echo "ERROR: STREET6_VPN_PSK is required for IPsec. It is the Pre-shared key from the FortiClient profile."; exit 4; }
command -v ipsec >/dev/null || {
  echo "strongSwan is not installed. On Debian:"
  echo "  sudo apt-get update && sudo apt-get install -y strongswan strongswan-pki libcharon-extra-plugins"
  exit 5
}

# Secrets go to a root-only file, never into the config or the process list.
sudo tee /etc/ipsec.secrets >/dev/null <<SECRETS
: PSK "$PSK"
$USER_ : XAUTH "$PASS"
SECRETS
sudo chmod 600 /etc/ipsec.secrets

sudo tee /etc/ipsec.conf >/dev/null <<CONF
config setup
    charondebug="ike 1, cfg 1"

conn street6-oms
    keyexchange=ikev1
    authby=xauthpsk
    xauth=client
    xauth_identity=$USER_
    left=%defaultroute
    leftsourceip=%config
    leftauth=psk
    leftauth2=xauth
    right=$HOST
    rightauth=psk
    rightsubnet=10.61.0.0/16
    auto=add
    dpdaction=restart
    ike=aes256-sha256-modp2048,aes256-sha1-modp1024!
    esp=aes256-sha256,aes256-sha1!
CONF

sudo ipsec restart
sleep 4
sudo ipsec up street6-oms
sudo ipsec status street6-oms
