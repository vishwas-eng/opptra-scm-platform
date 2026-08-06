# Security Review & Remediation, 2026-07-22

An adversarial review (external attacker + malicious insider threat models) was run over
the whole platform. Architecture was found sound: parameterized SQL throughout, real
RBAC, escaped DOM output, non-root container, DB/Redis not internet-exposed, narrow
session-death detection. Findings and their resolution:

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | HIGH | UC password leaked into logs via the OAuth token URL (query string) on any retry | **FIXED**, `http.js` now logs `origin+pathname` only (`safeUrl`), never query strings |
| 2 | HIGH | Default deploy served plaintext HTTP → Google SSO won't run, `Secure` cookie dropped → login loop; creds in the clear | **FIXED**, deploy auto-enables HTTPS via `<ip>.sslip.io` + Caddy auto-TLS; cookie `secure` now follows real scheme (`PUBLIC_URL`) |
| 3 | MED-HIGH | Deactivation / role change not enforced until the 12h JWT expired | **FIXED**, `requireUser`/`requireRole` re-check the DB per request (15s cache); role/active change invalidates cache immediately |
| 4 | MED-HIGH | Insider could flood the concurrency-1 queue (batch fan-out, viewer-triggerable UC jobs, noeviction Redis) | **FIXED**, per-user rate limits on job routes, batch cap 200→50, `so-status` now ops-only, queue depth cap (503 when full) |
| 5 | MED | `safe()` swallowed `SessionError` → dead session caused ~1h of silent retries | **FIXED**, `safe()` re-throws `SessionError`/`ConfigError`; run fails fast |
| 6 | MED | No security headers / CSP; app was framable (clickjacking) | **FIXED**, `@fastify/helmet` with tight CSP + `frame-ancestors 'none'` (test-asserted) |
| 7 | LOW-MED | `/healthz` leaked UC session state unauthenticated | **FIXED**, returns only `{ok, db}`; session detail is behind auth |
| 8 | LOW | Last-admin lockout / admin self-demotion possible | **FIXED**, guards against self-demote/deactivate and removing the last active admin |
|, | LOW | Viewer could read all runs (broad internal read) | Accepted for an internal tool; documented. Tighten later if needed. |
|, | hygiene | dead `enqueueAndWait`, missing `unhandledRejection` net, loose schemas | **FIXED**, removed dead code; added global rejection handlers on api+worker |

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

---

# Security Review round 2, 2026-08-03 (Agent connector platform)

Adversarial review of the Agent connector work (shared `@opptra/agent-connectors`, UC
action expansion, Waypoint filtered reads, playbook scheduling). Threat models: external
attacker, malicious insider, and **prompt injection via content the agent reads**.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | **CRITICAL** | `GET /api/runs/:runUid` had no ownership check, any signed-in user could read any run by id. Its sibling `GET /api/runs` scopes by user. Agent playbook runs store the owner's bound-sheet contents / Drive text / UC payloads in `result`, and `runUid` is posted into Slack alerts | **FIXED**, non-admins are scoped to `user_email`; someone else's run 404s (no existence oracle) |
| 2 | **CRITICAL** | `trustProxy: true` trusted the whole `X-Forwarded-For` chain, so `req.ip` was caller-controlled. Every per-IP and per-user rate limit could be bypassed by rotating a fake XFF per request, including the limit protecting the concurrency-1 worker queue | **FIXED**, `trustProxy: 1` (exactly one hop: Caddy, which appends the real peer). Verified: forged `6.6.6.6` no longer wins |
| 3 | HIGH | Per-action `inputSchema` was decorative, never validated. The invoke route's body schema is `params: {type:'object'}`, so `maxItems`/`maxLength`/`enum` were unenforced: a 50 000-SKU array reached UC's public REST on the tenant bearer; an arbitrary `facility` string re-pinned the session-global facility for following jobs | **FIXED**, ajv-compiled `inputSchema` enforced in `invoke()` before any upstream call; returns `INVALID_INPUT` |
| 4 | HIGH | `drive_search` accepted a raw Drive `q` expression (unescaped, LLM-controlled), the one hole in the bind-first ACL. Content read from a bound sheet/CSV could instruct the agent to enumerate the entire Drive (`fullText contains 'password'`) | **FIXED**, raw `query` removed; only an escaped `nameContains` plus a fixed `mimeType` allowlist |
| 5 | HIGH | `sheets_copy_range` fell back to the **source** resourceId when only `destSpreadsheetId` was given (the resolver short-circuits on resourceUid and ignores externalId) → wrote over the source sheet and returned `ok: true` | **FIXED**, destination resolves independently; falls back to source only when no destination was named at all |
| 6 | HIGH | `sanitizeResult` replaced any result over 4 KB with an opaque `{truncated, preview}` blob, discarding `ok`/`code`/`error`; capped arrays at 50 silently; redacted by **key name only** (a `JSESSIONID=…` sitting in a value survived); threw `RangeError` on cyclic input | **FIXED**, shrinks arrays instead of the result, preserves control fields, scrubs secret-shaped **values** (JSESSIONID / bearer / JWT / Google refresh), cycle-safe |
| 7 | MED | Daily playbooks of **deactivated** users kept firing forever, re-registered on every worker boot, running under a departed employee's stored Google grant, with no UI left to pause them | **FIXED**, owner `is_active` joined at re-registration and re-checked at run time |
| 8 | MED | Disconnecting the Agent's Google tile revoked the per-user OAuth token **by default**, silently breaking Packing Mail's Gmail drafts | **FIXED**, revoking is now explicit opt-in (`revokeGoogle: true`) |
| 9 | MED | UC actions echoed unrecognised upstream bodies back (`raw: d`), and `returns.bulkReturnSummary` returned the whole reverse-pickup body (customer name/address/phone) into `runs.result` | **FIXED**, named fields only; on a shape miss report top-level **key names** (`shapeHint`), never values |
| 10 | MED | Truncation left sibling counters (`count`, `limit`) at the original length, so the model reasoned over rows it could not see | **FIXED**, counters corrected + explicit `droppedItems {returned, total}` |
| 11 | MED | `resolveBoundResource` / `waitForRun` returned prose-only errors, defeating the `code`-based contract for the two most common agent failures | **FIXED**, `NOT_BOUND` / `INVALID_INPUT` / `TIMEOUT` codes emitted with `retryable` |
| 12 | LOW | `reports.exportJobCreate` dropped the date filter when `fromMs` was `0` (falsy) → exported all history | **FIXED**, `!= null` check |
| 13 | LOW | Playbooks accepted unknown tool names at save time; the typo only surfaced on the 3 AM run | **FIXED**, `isKnownTool` validation returns 400 at save |
| 14 | LOW | Tool-router regexes matched substrings (`inv` inside "**inv**entory") and ate the `SO` prefix of `SO02780` | **FIXED**, `\b` anchors + separator-required prefix matching; regression-tested |

### Verified clean

- `buildWaypointSOQuery`, fully parameterized; an injection payload stays a bound value and never reaches the SQL text (test-asserted).
- Migration 013, `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT` is idempotent, no table rewrite on PG11+, runs inside the runner's per-file transaction.
- No worker self-deadlock: `agent.playbook.run` calls the UC connector directly rather than enqueueing into its own concurrency-1 queue.
- No regressions: packing, sheet update, e-way, reverse DC, return, inventory and ASN suites all pass (243/243).

### Known, accepted, not fixed here

- **Agent chat holds a request while polling a UC Run** (up to 90 s, 800 ms interval). Not a deadlock, the worker path is direct, but a chatty session can hold connections and add `connector-unicommerce` rows to the runs ledger. Move to SSE/streaming when the agent runtime is next touched.
- **No approval gate on mutating Sheets tools.** `MUTATING_TOOLS` is exported and tested but nothing consults it yet; `sheets_write` / `clear_range` execute unattended, and a saved playbook repeats them daily. Wire `requireApproval` + `dryRun` through the executor before exposing the Agent beyond admins.
- **Waypoint pool ignores `dbUrl` after the first call** (module singleton). Harmless with one env var; fix before a second Waypoint database exists. `closeWaypointDb` is still not called on worker shutdown (masked by `process.exit`).
