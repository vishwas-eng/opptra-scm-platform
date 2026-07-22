# Security Review & Remediation — 2026-07-22

An adversarial review (external attacker + malicious insider threat models) was run over
the whole platform. Architecture was found sound: parameterized SQL throughout, real
RBAC, escaped DOM output, non-root container, DB/Redis not internet-exposed, narrow
session-death detection. Findings and their resolution:

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | HIGH | UC password leaked into logs via the OAuth token URL (query string) on any retry | **FIXED** — `http.js` now logs `origin+pathname` only (`safeUrl`), never query strings |
| 2 | HIGH | Default deploy served plaintext HTTP → Google SSO won't run, `Secure` cookie dropped → login loop; creds in the clear | **FIXED** — deploy auto-enables HTTPS via `<ip>.sslip.io` + Caddy auto-TLS; cookie `secure` now follows real scheme (`PUBLIC_URL`) |
| 3 | MED-HIGH | Deactivation / role change not enforced until the 12h JWT expired | **FIXED** — `requireUser`/`requireRole` re-check the DB per request (15s cache); role/active change invalidates cache immediately |
| 4 | MED-HIGH | Insider could flood the concurrency-1 queue (batch fan-out, viewer-triggerable UC jobs, noeviction Redis) | **FIXED** — per-user rate limits on job routes, batch cap 200→50, `so-status` now ops-only, queue depth cap (503 when full) |
| 5 | MED | `safe()` swallowed `SessionError` → dead session caused ~1h of silent retries | **FIXED** — `safe()` re-throws `SessionError`/`ConfigError`; run fails fast |
| 6 | MED | No security headers / CSP; app was framable (clickjacking) | **FIXED** — `@fastify/helmet` with tight CSP + `frame-ancestors 'none'` (test-asserted) |
| 7 | LOW-MED | `/healthz` leaked UC session state unauthenticated | **FIXED** — returns only `{ok, db}`; session detail is behind auth |
| 8 | LOW | Last-admin lockout / admin self-demotion possible | **FIXED** — guards against self-demote/deactivate and removing the last active admin |
| — | LOW | Viewer could read all runs (broad internal read) | Accepted for an internal tool; documented. Tighten later if needed. |
| — | hygiene | dead `enqueueAndWait`, missing `unhandledRejection` net, loose schemas | **FIXED** — removed dead code; added global rejection handlers on api+worker |

**Auth model (confirmed legitimate, no bypass anywhere):** the platform never automates a
Unicommerce login. A human admin logs in on Unicommerce (doing the CAPTCHA themselves); the
Session Helper extension (their own browser, `cookies` permission) reads only the
`JSESSIONID` cookie and POSTs it to `/api/ingest/uc-session`, authenticated by a per-admin
ingest token. The platform then keeps that session warm. No passwords are read, stored, or
transmitted by any component; no CAPTCHA/bot-detection is ever circumvented.

**Tests:** `apps/api/test/routes.test.js` asserts every protected route 401s anonymous
callers before any DB access, CSP/anti-frame headers are present, and `/api/config` leaks
nothing but the (public) Google client id. `packages/uc-client/test` locks the session-death
semantics (403 ≠ death, `successful:false` ≠ death, USER_NOT_LOGGED_IN = death, mutex'd refresh).
