// Admin-only: session cookie paste + helper-extension ingest, user management.
import { randomBytes, createHash } from 'node:crypto';
import { query, audit, config, logger } from '@opptra/core';
import { enqueue } from '../queue.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Test a JSESSIONID against Unicommerce RIGHT NOW, synchronously, so the admin gets an
// immediate real answer (not "saved" that might silently still be dead). Hits a cheap
// endpoint with the cookie directly - no worker round-trip, no waiting for a cron tick.
async function testUcCookie(cookie) {
  const base = config().UC_BASE_URL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/data/user/facilities`, {
      headers: { Cookie: 'JSESSIONID=' + cookie, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 401, 403].includes(res.status)) {
      return { alive: false, reason: `Unicommerce rejected the session (HTTP ${res.status}). It may be expired, or from the wrong instance (checking against ${base}).` };
    }
    const data = await res.json().catch(() => null);
    if (!data) return { alive: false, reason: `Unexpected response from Unicommerce (HTTP ${res.status}, not JSON).` };
    if (data.successful === false) {
      return { alive: false, reason: (data.errors || []).map((e) => e.description || e.message).join('; ') || 'Unicommerce rejected the session.' };
    }
    return { alive: true, facility: data.currentFacilityCode || null };
  } catch (err) {
    logger.warn({ err: String(err) }, 'uc session test call failed');
    return { alive: false, reason: `Could not reach Unicommerce at ${base}: ${err.message || err}` };
  }
}

// After a verified-alive paste, wake the worker immediately (it owns automations) so it
// reloads the new cookie in seconds instead of waiting for the ~4-min keepalive cron.
async function nudgeWorker() {
  await enqueue('system.keepalive', {}, { removeOnComplete: true, removeOnFail: true }).catch(() => {});
}

export default async function adminRoutes(app) {
  const adminOnly = { preValidation: app.requireRole('admin') };

  // Paste a fresh JSESSIONID captured from the browser. Stored in Postgres; the worker
  // picks it up on its next call (it re-reads on session death and on keepalive).
  app.post('/api/admin/uc-session', {
    ...adminOnly,
    schema: {
      body: {
        type: 'object', required: ['jsessionid'], additionalProperties: false,
        properties: { jsessionid: { type: 'string', minLength: 8, maxLength: 512 } },
      },
    },
  }, async (req, reply) => {
    const cookie = req.body.jsessionid.trim().replace(/^JSESSIONID=/i, '');
    const test = await testUcCookie(cookie);

    if (!test.alive) {
      // Do NOT overwrite a working session with one that just failed verification.
      // Record the attempt so it's visible in the audit trail either way.
      await audit(req.user.email, 'uc-session-paste-rejected', { reason: test.reason });
      return reply.code(400).send({ ok: false, alive: false, error: test.reason });
    }

    await query(
      `UPDATE uc_session SET jsessionid = $1, source = 'admin-paste', status = 'alive',
        updated_by = $2, updated_at = now(), last_ok_at = now(), last_check_at = now(), fail_count = 0,
        needs_relogin = false, relogin_since = NULL,
        facility = COALESCE(NULLIF($3,''), facility) WHERE id = 1`,
      [cookie, req.user.email, test.facility || '']
    );
    await audit(req.user.email, 'uc-session-paste', { facility: test.facility });
    await nudgeWorker();
    return { ok: true, alive: true, facility: test.facility };
  });

  // ── Session-helper ingest ────────────────────────────────────────────────
  // The "Opptra Session Helper" browser extension POSTs a freshly-captured
  // JSESSIONID here after the admin logs into Unicommerce by hand. Auth is a
  // per-admin bearer ingest token (NOT the web cookie - the extension is a
  // different origin). No login automation server-side; the human did the login.
  app.post('/api/ingest/uc-session', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['jsessionid', 'token'],
        properties: {
          jsessionid: { type: 'string', minLength: 8, maxLength: 512 },
          token: { type: 'string', minLength: 20, maxLength: 200 },
          facility: { type: 'string', maxLength: 64 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { rows } = await query(
      'SELECT id, owner_email FROM ingest_tokens WHERE token_hash = $1 AND NOT revoked',
      [sha256(req.body.token)]);
    if (!rows.length) return reply.code(401).send({ error: 'invalid or revoked ingest token' });
    const owner = rows[0].owner_email;
    const cookie = req.body.jsessionid.trim().replace(/^JSESSIONID=/i, '');
    const test = await testUcCookie(cookie);
    if (!test.alive) {
      await audit(`helper:${owner}`, 'uc-session-ingest-rejected', { reason: test.reason });
      return reply.code(400).send({ ok: false, alive: false, error: test.reason });
    }
    await query(
      `UPDATE uc_session SET jsessionid = $1, source = 'admin-paste', status = 'alive',
        updated_by = $2, updated_at = now(), last_ok_at = now(), last_check_at = now(), fail_count = 0,
        needs_relogin = false, relogin_since = NULL,
        facility = COALESCE(NULLIF($3,''), facility) WHERE id = 1`,
      [cookie, `helper:${owner}`, req.body.facility || test.facility || '']);
    await query('UPDATE ingest_tokens SET last_used = now() WHERE id = $1', [rows[0].id]);
    await audit(`helper:${owner}`, 'uc-session-ingest', { facility: test.facility });
    await nudgeWorker();
    return { ok: true, alive: true, message: 'session captured and verified alive' };
  });

  // Where the admin should log in (drives the "Re-login" button in the UI).
  app.get('/api/admin/uc-login-url', adminOnly, async () => {
    return { url: config().UC_BASE_URL };
  });

  // Create / list / revoke ingest tokens (one per admin's helper install).
  app.post('/api/admin/ingest-tokens', {
    ...adminOnly,
    schema: { body: { type: 'object', properties: { label: { type: 'string', maxLength: 64 } }, additionalProperties: false } },
  }, async (req) => {
    const raw = randomBytes(24).toString('base64url'); // shown once, never stored raw
    await query('INSERT INTO ingest_tokens (token_hash, label, owner_email) VALUES ($1, $2, $3)',
      [sha256(raw), req.body?.label || 'helper', req.user.email]);
    await audit(req.user.email, 'ingest-token-create', { label: req.body?.label || 'helper' });
    return { token: raw, note: 'copy this into the Session Helper extension now, it will not be shown again' };
  });

  app.get('/api/admin/ingest-tokens', adminOnly, async () => {
    const { rows } = await query(
      'SELECT id, label, owner_email, created_at, last_used, revoked FROM ingest_tokens ORDER BY created_at DESC');
    return { tokens: rows };
  });

  app.delete('/api/admin/ingest-tokens/:id', {
    ...adminOnly,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req) => {
    await query('UPDATE ingest_tokens SET revoked = true WHERE id = $1', [req.params.id]);
    await audit(req.user.email, 'ingest-token-revoke', { id: req.params.id });
    return { ok: true };
  });

  app.get('/api/admin/users', adminOnly, async () => {
    const { rows } = await query(
      'SELECT email, name, role, is_active, created_at, last_login FROM users ORDER BY created_at');
    return { users: rows };
  });

  app.post('/api/admin/users/:email', {
    ...adminOnly,
    schema: {
      params: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['admin', 'ops', 'viewer'] },
          is_active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const email = req.params.email.toLowerCase();
    if (email === req.user.email && (req.body.is_active === false || (req.body.role && req.body.role !== 'admin'))) {
      return reply.code(400).send({ error: 'cannot deactivate or demote yourself' });
    }
    // Never allow removing the last active admin - that locks everyone out.
    if (req.body.is_active === false || (req.body.role && req.body.role !== 'admin')) {
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND email <> $1`, [email]);
      const { rows: target } = await query('SELECT role FROM users WHERE email = $1', [email]);
      if (target[0]?.role === 'admin' && rows[0].n === 0) {
        return reply.code(400).send({ error: 'cannot remove the last active admin' });
      }
    }
    const sets = [];
    const params = [];
    if (req.body.role) { params.push(req.body.role); sets.push(`role = $${params.length}`); }
    if (typeof req.body.is_active === 'boolean') { params.push(req.body.is_active); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing to update' });
    params.push(email);
    const { rowCount } = await query(`UPDATE users SET ${sets.join(', ')} WHERE email = $${params.length}`, params);
    if (!rowCount) return reply.code(404).send({ error: 'user not found' });
    app.invalidateUserCache(email); // role/active change takes effect immediately
    await audit(req.user.email, 'user-update', { target: email, ...req.body });
    return { ok: true };
  });

  app.get('/api/admin/audit', adminOnly, async () => {
    const { rows } = await query('SELECT at, actor, event, detail FROM audit_log ORDER BY at DESC LIMIT 200');
    return { audit: rows };
  });

  // ── Analytics: the "is everything working?" panel ────────────────────────
  app.get('/api/admin/analytics', adminOnly, async () => {
    const since = "now() - interval '7 days'";
    const [totals, byAutomation, byUser, recentErrors, sessionRow, queueRow] = await Promise.all([
      query(`SELECT status, count(*)::int n FROM runs WHERE created_at > ${since} GROUP BY status`),
      query(`SELECT automation,
                count(*)::int total,
                count(*) FILTER (WHERE status='succeeded')::int ok,
                count(*) FILTER (WHERE status='failed')::int failed,
                count(*) FILTER (WHERE status IN ('queued','running','pending_retry'))::int active
              FROM runs WHERE created_at > ${since} GROUP BY automation ORDER BY total DESC`),
      query(`SELECT user_email,
                count(*)::int total,
                count(*) FILTER (WHERE status='succeeded')::int ok,
                count(*) FILTER (WHERE status='failed')::int failed
              FROM runs WHERE created_at > ${since} AND user_email <> 'system'
              GROUP BY user_email ORDER BY total DESC LIMIT 50`),
      query(`SELECT run_uid, user_email, automation, action, input, error, finished_at
              FROM runs WHERE status='failed' AND created_at > ${since}
              ORDER BY finished_at DESC NULLS LAST LIMIT 25`),
      query(`SELECT status, source, needs_relogin, relogin_since, last_ok_at, fail_count,
                (jsessionid <> '') has_cookie FROM uc_session WHERE id = 1`),
      query(`SELECT count(*) FILTER (WHERE status='queued')::int queued,
                     count(*) FILTER (WHERE status='running')::int running,
                     count(*) FILTER (WHERE status='pending_retry')::int pending
              FROM runs WHERE created_at > ${since}`),
    ]);
    const totalsMap = Object.fromEntries(totals.rows.map((r) => [r.status, r.n]));
    return {
      windowDays: 7,
      totals: totalsMap,
      byAutomation: byAutomation.rows,
      byUser: byUser.rows,
      recentErrors: recentErrors.rows,
      session: sessionRow.rows[0],
      inflight: queueRow.rows[0],
    };
  });
}
