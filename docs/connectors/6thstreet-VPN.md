# 6th Street: the VPN problem, and how to solve it

## The two systems (do not conflate them)

| System | What it holds | VPN? | Status |
|---|---|---|---|
| **Seller portal** `prod-seller-portal-backend.6thstreet.com/sellerportal/` | **Inventory + pricing** | **No**, plain internet | Client built (`packages/connectors-6thstreet/src/portalClient.js`). Blocked only on a working password. |
| **IBM Sterling OMS** `apg-oms.prod.coc.ibmcloud.com` | Picklist, invoice, shipping label (the SO/pack side) | **Yes** | Blocked on VPN routing, this doc. |

Verified again 2026-08-06: the seller portal answered from a public host; the OMS host
timed out from outside the VPN.

**So inventory sync never needed the VPN.** Only the pack/SO documents do.

## Why `10.61.1.11` cannot work

`STREET6_VPN_HOST=10.61.1.11` is an **RFC1918 private address**. Nothing on the public
internet, including the GCP VM, can route to it. Pointing `openfortivpn` at it fails
with "no route to host", and no amount of credentials changes that.

Almost certainly `10.61.1.11` is not what FortiClient actually dials. A FortiClient
profile connects to a **public gateway** (a hostname or public IP, usually on port 443
or 10443); `10.61.1.11` looks like an internal host reached *after* the tunnel is up, or
simply the wrong field was recorded.

### Step 1, read the real gateway off a machine that already connects

Fastest path, and it may unblock everything:

- **FortiClient GUI** → Remote Access → the `6thStreet-OMS` profile → the
  **Remote Gateway** field. That value (e.g. `vpn.company.com:10443`) is what we need.
- **macOS config:** `/Library/Application Support/Fortinet/FortiClient/conf/`
- **Windows:** `HKLM\SOFTWARE\Fortinet\FortiClient\Sslvpn\Tunnels\`
- Or simply, while connected: `netstat -rn` shows the tunnel peer, and
  `scutil --dns` / the FortiClient status pane shows the gateway.

If that yields a public hostname, set `STREET6_VPN_HOST` to it and Path A below becomes
viable.

## The three paths

### Path A, headless VPN on the server
`openfortivpn <public-gateway> -u <user> -p <pass>` on the VM, then the OMS becomes
reachable. **Works only if** the gateway is public *and* the VPN allows a non-interactive
client. It usually does not: FortiClient deployments commonly require a certificate,
MFA/OTP, or a host-check that a headless client cannot satisfy. Worth ten minutes of
testing once you have the gateway; do not build on it until it is proven.

### Path B, relay agent on a machine that already has VPN ✅ recommended
A small Node process runs on a laptop or office box **that is already on the VPN**. It
**polls the platform outbound over HTTPS**, claim a job, fetch the documents from the
OMS through the existing tunnel, upload them back, done.

```
Platform (GCP)                     Operator machine (on VPN)
     │                                      │
     │◀──── GET  /api/relay/jobs  (poll) ───│   outbound HTTPS only
     │────▶ job: fetch docs for SO 403770599│
     │                                      ├──▶ IBM OMS (through the tunnel)
     │◀──── POST /api/relay/jobs/:id/result │
     ▼                                      │
  emails the pack                           │
```

Why this is the right answer:

- **No inbound firewall change, no site-to-site, no IT ticket.** Everything is an
  outbound HTTPS call from a machine that already has access.
- **Topology-proof.** It does not matter whether the gateway is public, whether MFA is
  required, or whether the VPN is split-tunnel, a human already solved that by being
  logged in.
- **Same pattern reusable** for any future VPN-gated or MFA-gated portal.
- Auth is a normal platform access token, so every fetch is attributed and audited like
  any other action.

Cost: the machine must be on and connected when jobs run. For a daily pack-email that is
a laptop open during working hours; for reliability, a small always-on box in the office.

### Path C, site-to-site GCP ↔ their network
Cloud VPN or an IPsec tunnel from the GCP VPC to the `10.61.x.x` network. Fully
unattended and the best long-term answer, but it needs Apparel Group IT to provision the
peer, agree on address ranges and open the tunnel. Start the conversation in parallel;
do not block on it.

## Recommendation

1. **Now:** fix the seller-portal password → inventory sync goes live, no VPN involved.
2. **Now:** run the relay agent for picklist/invoice/label (Path B).
3. **Ask IT, in parallel:** the public VPN gateway hostname (unlocks Path A testing) and
   whether a site-to-site tunnel is possible (Path C).

## Do not do this

Do not retry the portal login with guessed passwords. 6th Street returns HTTP **500**
with "Incorrect username or password" for a bad credential, the client now detects that
and refuses to retry, precisely because repeated failed logins lock seller accounts.
