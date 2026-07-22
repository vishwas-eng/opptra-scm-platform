# Platform Status — what's production-ready, what's next

**Updated:** 2026-07-22 · Single source of truth for "what works, what's left."

## Automations on the platform

| Automation | Module | Worker | API | Web tab | Tests | Live-verified? |
|---|---|---|---|---|---|---|
| **Return + re-dispatch** | ✅ | ✅ | ✅ | ✅ | ✅ | needs a live session run |
| **E-way bill** | ✅ | ✅ | ✅ | ✅ | ✅ | needs a live session run |
| **Inward / Outward / Full-cycle** | ✅ | ✅ | ✅ | ✅ | ✅ | needs a live session run |
| ASN compile (A3) | ⏳ | — | — | (disabled) | — | port pending |
| Reverse DC (A4) | ⏳ | — | — | (disabled) | — | port pending |
| Packing mail (A2) | ⏳ needs Gmail delegation | — | — | (disabled) | — | port pending |
| Sheet update (A1) | ⏳ needs Sheets SA access | — | — | (disabled) | — | port pending |
| Reports digest (50+) | ⏳ needs Google + report list | — | — | (disabled) | — | port pending |
| Home Centre sync | ⏳ needs Vinculum creds | — | — | (disabled) | — | port pending |
| Downloads (was extension) | ✅ extension shipped in Extensions tab | — | — | ✅ | — | works (browser session) |

"Live-verified" = one real end-to-end run against Unicommerce. **Not possible from a dev
machine** — it needs either the whitelisted account or a fresh JSESSIONID pasted in the Admin
tab. The code paths, payloads, and endpoints are the same ones already proven in the Apps
Script apps (cited in each module's header); the platform port preserves them exactly.

## Engineering practices in place (why this isn't a throwaway)

- **One client owns Unicommerce.** All UC traffic flows through `packages/uc-client`; only the
  worker runs it. Session death is narrowly defined (401 / login-redirect / USER_NOT_LOGGED_IN —
  **not** 403 or `successful:false`), refresh is mutex'd, facility calls are serialized.
- **Global rate limiting.** One shared token bucket paces every public + internal call
  (`UC_MAX_RPS`/`UC_BURST`); HTTP 429 is honored with Retry-After backoff (safe even for POSTs,
  since 429 = rejected-before-processing). This is the "don't trip the rate limit" guarantee.
- **Idempotency.** Multi-step automations memoize each step per `reqId` in a durable Postgres
  ledger — a retry resumes and never double-creates a PO / double-invoices / double-adds stock.
  Non-idempotent UC mutations never blind-retry.
- **Real auth.** Google SSO restricted to `@opptra.com`; RBAC (admin/ops/viewer); the DB is
  re-checked every request (deactivation takes effect immediately, not in 12h); auth gates at
  `preValidation` so unauthenticated callers can't even probe the request schema.
- **Attribution + audit.** Every action writes a `runs` row (who/what/input/result); security
  events go to an append-only `audit_log`.
- **Fail loud.** Session death, stuck jobs, and generation failures raise deduped Slack alerts;
  the Dashboard shows session + run health.
- **Tested.** 29 unit tests cover session death classification, facility serialization, rate
  limiting + 429, dry-run-never-writes, idempotency, and each automation's flow. `npm test` is
  green; `npm run check` syntax-checks every file.
- **Reproducible deploy.** Docker Compose (postgres/redis/api/worker/caddy) + an idempotent
  one-click GCP script with automatic HTTPS. No manual server fiddling.

## To finish the remaining ports, we need (from you)

1. **Google Workspace domain-wide delegation** for a service account → unlocks Packing mail
   (Gmail send-as), Sheet update, and the Reports digest.
2. **The reports-digest spec** — which ~50 reports, which warehouses, what the email should say.
3. **Vinculum credentials** → Home Centre sync.
4. **One live session** (whitelisted account, or a pasted JSESSIONID) → to run the
   already-built Return / E-way bill / Inward-Outward flows end-to-end once and tick
   "live-verified."

None of these block the three shipped automations from running the moment a session is present.
