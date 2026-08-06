# Unicommerce multi-instance sessions

Each UC tenant has its **own** `JSESSIONID`. Logging into staging must never overwrite India packing/sheet/e-way.

Company codes from UC **Choose your company** (authoritative):

| Code | Correct URL | Instance id |
|------|-------------|-------------|
| `oppdoor` | `https://oppdoor.unicommerce.co.in` | `india` |
| `oppdoorstg` | `https://oppdoorstg.unicommerce.com` | `staging` |
| `opptrauae` | `https://opptrauae.unicommerce.com` | `uae` |
| `opptraksa` | `https://opptraksa.unicommerce.com` | `ksa` |

> **Do not use** `oppdooruae.unicommerce.com` — wrong company code. Correct UAE tenant is **`opptrauae`**.

| Instance id | Host | Used by |
|-------------|------|---------|
| `india` | `oppdoor.unicommerce.co.in` (`UC_BASE_URL`) | Packing, sheet, e-way, reverse DC, ASN, returns, India connector |
| `uae` | `opptrauae.unicommerce.com` (`HC_UC_UAE_BASE_URL`) | Home Centre **inventory** snapshot (bearer); optional session paste |
| `ksa` | `opptraksa.unicommerce.com` (`HC_UC_KSA_BASE_URL`) | KSA tenant (6th Street / future); session vault row |
| `staging` | `oppdoorstg.unicommerce.com` (`HC_UC_STAGING_BASE_URL`) | Home Centre **orders** → SO create (bearer); optional session paste |

### Planned: FZE (`scfze`)

Identity DL: **`scfze.automations@opptra.com`**. Not in the india/uae/ksa/staging matrix yet — **no** `UC_*_FZE` keys and **no** Unicommerce host until ops confirms company code / tenant URL. Do not invent a hostname.

## Automation identities (DLs + India mailbox)

| Region | Intended identity | Notes |
|--------|-------------------|-------|
| **India** | `sc.automations@opptra.com` | Real mailbox; **only** identity for India UC |
| **UAE** | `scuae.automations@opptra.com` | Distribution list (not a full mailbox) |
| **KSA** | `scksa.automations@opptra.com` | Distribution list |
| **FZE** | `scfze.automations@opptra.com` | Distribution list; UC wiring TBD |

Policy: regional bots stay on their own identity. Never fall back UAE/KSA/staging/FZE to India `sc.automations`.

### DL ≠ UC login

A Google/Outlook **distribution list can receive status mail** and be the labeled `*_USER` in env, but Unicommerce OAuth / password-grant requires a **real UC user**. A DL alone cannot log into UC.

To make UAE/KSA (and later FZE) work, pick one:

1. **UC user** — create a user on that tenant whose username is the DL email (`scuae…` / `scksa…`) and set `*_PASS` accordingly, **or**
2. **Session paste** — Admin-paste `JSESSIONID` from a real user who can access that tenant, while `UC_UAE_USER` / `UC_KSA_USER` (or `HC_UC_*`) is set to the DL for labeling / alerts.

## Account isolation (hard rule)

| Instance | Credentials | Never use |
|----------|-------------|-----------|
| **india** | `UC_USER` / `UC_PASS` = `sc.automations@opptra.com` | — |
| **uae** | `HC_UC_UAE_USER`/`PASS` or `UC_UAE_USER`/`PASS` → `scuae.automations@opptra.com` + UC user password **or** session paste | India bot |
| **ksa** | `HC_UC_KSA_USER`/`PASS` or `UC_KSA_USER`/`PASS` → `scksa.automations@opptra.com` + UC user password **or** session paste | India bot |
| **staging** | `HC_UC_STAGING_USER`/`PASS` only (personal account for later testing) | India bot |

There is **no** fallback from UAE/KSA/staging to `UC_USER` / `sc.automations`.

## Access matrix (live verify 2026-08-04)

| Instance | Host | OAuth password-grant | Session `/data` ping | Notes |
|----------|------|----------------------|----------------------|-------|
| **india** | `oppdoor.unicommerce.co.in` | **OK** (200, ~12h) | **OK** (vault `alive`) | India bot only |
| **staging** | `oppdoorstg.unicommerce.com` | needs `HC_UC_STAGING_*` | paste when ready | Personal/staging bot later — not India |
| **uae** | `opptrauae.unicommerce.com` | needs dedicated UAE bot / session | paste when ready | Facility **`opptrauae`**. Wrong host `oppdooruae` → HTTP 500. Identity DL `scuae.automations@opptra.com` |
| **ksa** | `opptraksa.unicommerce.com` | needs dedicated KSA bot / session | paste when ready | Facility `opptraksa`; grant `LOOKUP_INVENTORY` on KSA bot. Identity DL `scksa.automations@opptra.com` |

### Retired wrong-host probes (do not retry)

| Candidate | Result |
|-----------|--------|
| `oppdooruae.unicommerce.com` | **Wrong** — use `opptrauae` |
| `oppdoorsa` / `oppdoorksa` / `oppdoorsaudi` | Dead ends — use `opptraksa` |

## Vault

Postgres `uc_session` PK `instance_id`:

- Rows: `india`, `uae`, `ksa`, `staging`
- Admin paste / ingest accept those ids; cookie is verified against that host before write
- `UC_JSESSIONID_OVERRIDE` → **india only**

## Keepalive

`system.keepalive` always pings `india`. Sibling instances only when they have a cookie (or after paste nudge).

## Status-mail recipients (future)

Today HC owner / 6th Street To: are personal (`HC_OWNER_EMAIL`, `STREET6_EMAIL_TO`). Regional DLs (`scuae` / `scksa` / later `scfze`) are the intended To: for GCC status mail once ops switches them — leave live lists unchanged until then.

## Home Centre auth note

HC orders (staging) + UAE inventory use **OAuth password-grant** with instance-specific `HC_UC_STAGING_*` / `HC_UC_UAE_*` (or `UC_UAE_*`). Clients bind to per-instance vault (`instance_id`) so one JSESSIONID cannot serve all tenants. Remember: DL identity still needs a real UC user or pasted session (see above).

See also `docs/HOMECENTRE.md`.
