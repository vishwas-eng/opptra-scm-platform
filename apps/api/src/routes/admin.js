// Admin-only: session cookie paste + helper-extension ingest, user management.
import { randomBytes, createHash } from 'node:crypto';
import { query, audit, config, logger } from '@opptra/core';
import {
  normalizeInstanceId,
  resolveInstanceBaseUrl,
  instanceIdFromHost,
  UC_INSTANCE_IDS,
  PgSessionStore,
} from '@opptra/uc-client';
import { enqueue } from '../queue.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Test a JSESSIONID against a specific UC instance RIGHT NOW, synchronously.
async function testUcCookie(cookie, instanceId = 'india') {
  const id = normalizeInstanceId(instanceId);
  const base = resolveInstanceBaseUrl(id, config()).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/data/user/facilities`, {
      headers: { Cookie: 'JSESSIONID=' + cookie, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 401, 403].includes(res.status)) {
      return {
        alive: false,
        instanceId: id,
        baseUrl: base,
        reason: `Unicommerce rejected the session (HTTP ${res.status}). It may be expired, or from the wrong instance (checking against ${base} / ${id}).`,
      };
    }
    const data = await res.json().catch(() => null);
    if (!data) {
      return {
        alive: false,
        instanceId: id,
        baseUrl: base,
        reason: `Unexpected response from Unicommerce (HTTP ${res.status}, not JSON).`,
      };
    }
    if (data.successful === false) {
      return {
        alive: false,
        instanceId: id,
        baseUrl: base,
        reason: (data.errors || []).map((e) => e.description || e.message).join('; ') || 'Unicommerce rejected the session.',
      };
    }
    return {
      alive: true,
      instanceId: id,
      baseUrl: base,
      facility: data.currentFacilityCode || null,
    };
  } catch (err) {
    logger.warn({ err: String(err), instanceId: id }, 'uc session test call failed');
    return {
      alive: false,
      instanceId: id,
      baseUrl: base,
      reason: `Could not reach Unicommerce at ${base}: ${err.message || err}`,
    };
  }
}

async function persistSession({ cookie, instanceId, actor, facility, baseUrl }) {
  const id = normalizeInstanceId(instanceId);
  const resolvedBase = baseUrl || resolveInstanceBaseUrl(id, config());
  await query(
    `INSERT INTO uc_session (instance_id, base_url, jsessionid, source, status, updated_by,
       updated_at, last_ok_at, last_check_at, fail_count, needs_relogin, relogin_since, facility)
     VALUES ($1, $2, $3, 'admin-paste', 'alive', $4, now(), now(), now(), 0, false, NULL, $5)
     ON CONFLICT (instance_id) DO UPDATE SET
       jsessionid = EXCLUDED.jsessionid,
       source = 'admin-paste',
       status = 'alive',
       updated_by = EXCLUDED.updated_by,
       updated_at = now(),
       last_ok_at = now(),
       last_check_at = now(),
       fail_count = 0,
       needs_relogin = false,
       relogin_since = NULL,
       facility = COALESCE(NULLIF(EXCLUDED.facility,''), uc_session.facility),
       base_url = CASE
         WHEN EXCLUDED.base_url <> '' THEN EXCLUDED.base_url
         ELSE uc_session.base_url
       END`,
    [id, resolvedBase, cookie, actor, facility || ''],
  );
}

// After a verified-alive paste, wake the worker immediately (it owns automations) so it
// reloads the new cookie in seconds instead of waiting for the ~4-min keepalive cron.
async function nudgeWorker(instanceId = 'india') {
  await enqueue(
    'system.keepalive',
    { instanceId },
    { removeOnComplete: true, removeOnFail: true },
  ).catch(() => {});
}

export default async function adminRoutes(app) {
  const adminOnly = { preValidation: app.requireRole('admin') };

  // Paste a fresh JSESSIONID for a selected UC instance.
  app.post('/api/admin/uc-session', {
    ...adminOnly,
    schema: {
      body: {
        type: 'object', required: ['jsessionid'], additionalProperties: false,
        properties: {
          jsessionid: { type: 'string', minLength: 8, maxLength: 512 },
          instanceId: { type: 'string', enum: [...UC_INSTANCE_IDS] },
        },
      },
    },
  }, async (req, reply) => {
    const cookie = req.body.jsessionid.trim().replace(/^JSESSIONID=/i, '');
    const instanceId = normalizeInstanceId(req.body.instanceId || 'india');
    const test = await testUcCookie(cookie, instanceId);

    if (!test.alive) {
      await audit(req.user.email, 'uc-session-paste-rejected', {
        reason: test.reason,
        instanceId,
      });
      return reply.code(400).send({ ok: false, alive: false, instanceId, error: test.reason });
    }

    await persistSession({
      cookie,
      instanceId,
      actor: req.user.email,
      facility: test.facility,
      baseUrl: test.baseUrl,
    });
    await audit(req.user.email, 'uc-session-paste', {
      facility: test.facility,
      instanceId,
    });
    await nudgeWorker(instanceId);
    return { ok: true, alive: true, instanceId, facility: test.facility, baseUrl: test.baseUrl };
  });

  // ── Session-helper ingest ────────────────────────────────────────────────
  app.post('/api/ingest/uc-session', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['jsessionid', 'token'],
        properties: {
          jsessionid: { type: 'string', minLength: 8, maxLength: 512 },
          token: { type: 'string', minLength: 20, maxLength: 200 },
          facility: { type: 'string', maxLength: 64 },
          instanceId: { type: 'string', enum: [...UC_INSTANCE_IDS] },
          baseUrl: { type: 'string', maxLength: 256 },
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
    const fromHost = req.body.baseUrl ? instanceIdFromHost(req.body.baseUrl) : null;
    const instanceId = normalizeInstanceId(req.body.instanceId || fromHost || 'india');
    const test = await testUcCookie(cookie, instanceId);
    if (!test.alive) {
      await audit(`helper:${owner}`, 'uc-session-ingest-rejected', {
        reason: test.reason,
        instanceId,
      });
      return reply.code(400).send({ ok: false, alive: false, instanceId, error: test.reason });
    }
    await persistSession({
      cookie,
      instanceId,
      actor: `helper:${owner}`,
      facility: req.body.facility || test.facility,
      baseUrl: test.baseUrl,
    });
    await query('UPDATE ingest_tokens SET last_used = now() WHERE id = $1', [rows[0].id]);
    await audit(`helper:${owner}`, 'uc-session-ingest', {
      facility: test.facility,
      instanceId,
    });
    await nudgeWorker(instanceId);
    return { ok: true, alive: true, instanceId, message: 'session captured and verified alive' };
  });

  // Where the admin should log in (drives the "Re-login" button in the UI).
  app.get('/api/admin/uc-login-url', adminOnly, async (req) => {
    const instanceId = normalizeInstanceId(req.query.instanceId || 'india');
    return { url: resolveInstanceBaseUrl(instanceId, config()), instanceId };
  });

  app.get('/api/admin/uc-sessions', adminOnly, async () => {
    const sessions = await PgSessionStore.listStatus();
    return { sessions, instances: UC_INSTANCE_IDS };
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

  // Shared analytics builder (7- or 30-day window). Used by /analytics and /kpi.
  async function buildAnalytics(windowDays = 7) {
    const days = windowDays === 30 ? 30 : 7;
    const since = `now() - interval '${days} days'`;
    const [totals, byAutomation, byUser, byAction, byDay, recentErrors, recentActivity, sessionRow, queueRow, usersTotal] = await Promise.all([
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
                count(*) FILTER (WHERE status='failed')::int failed,
                max(created_at) AS last_run_at
              FROM runs WHERE created_at > ${since} AND user_email <> 'system'
              GROUP BY user_email ORDER BY total DESC LIMIT 50`),
      query(`SELECT automation, action,
                count(*)::int total,
                count(*) FILTER (WHERE status='succeeded')::int ok,
                count(*) FILTER (WHERE status='failed')::int failed
              FROM runs WHERE created_at > ${since}
              GROUP BY automation, action ORDER BY total DESC LIMIT 80`),
      query(`SELECT date_trunc('day', created_at)::date AS day,
                count(*)::int total,
                count(*) FILTER (WHERE status='succeeded')::int ok,
                count(*) FILTER (WHERE status='failed')::int failed
              FROM runs WHERE created_at > ${since}
              GROUP BY 1 ORDER BY 1`),
      query(`SELECT run_uid, user_email, automation, action, input, error, finished_at, created_at
              FROM runs WHERE status='failed' AND created_at > ${since}
              ORDER BY finished_at DESC NULLS LAST LIMIT 25`),
      query(`SELECT run_uid, user_email, automation, action, status, created_at, finished_at
              FROM runs WHERE created_at > ${since} AND user_email <> 'system'
              ORDER BY created_at DESC LIMIT 40`),
      query(`SELECT instance_id, status, source, needs_relogin, relogin_since, last_ok_at, fail_count,
                (jsessionid <> '') has_cookie FROM uc_session WHERE instance_id = 'india'`),
      query(`SELECT count(*) FILTER (WHERE status='queued')::int queued,
                     count(*) FILTER (WHERE status='running')::int running,
                     count(*) FILTER (WHERE status='pending_retry')::int pending
              FROM runs WHERE created_at > ${since}`),
      query(`SELECT count(*)::int AS registered,
                     count(*) FILTER (WHERE last_login > ${since})::int AS active_logins
              FROM users WHERE is_active`),
    ]);
    const totalsMap = Object.fromEntries(totals.rows.map((r) => [r.status, r.n]));
    const succeeded = totalsMap.succeeded || 0;
    const failed = totalsMap.failed || 0;
    const decided = succeeded + failed;
    const featureKey = (automation) => String(automation || 'other').toLowerCase();
    const FEATURE_LABELS = {
      packing: 'Packing Mail', sheet: 'Sheet Update', ewaybill: 'E-way Bill',
      reversedc: 'Reverse DC', asn: 'ASN Compile', return: 'Return Flow',
      inventory: 'Inward/Outward', inward: 'Inward', outward: 'Outward',
      homecentre: 'Home Centre', uc: 'Order Lookup', system: 'System',
    };
    const features = byAutomation.rows.map((r) => {
      const d = (r.ok || 0) + (r.failed || 0);
      return {
        key: featureKey(r.automation),
        label: FEATURE_LABELS[featureKey(r.automation)] || r.automation,
        total: r.total, ok: r.ok, failed: r.failed, active: r.active,
        successRate: d ? Math.round((r.ok / d) * 1000) / 10 : null,
      };
    });
    return {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      totals: totalsMap,
      week: { total: Object.values(totalsMap).reduce((s, n) => s + n, 0), succeeded, failed },
      successRate: decided ? Math.round((succeeded / decided) * 1000) / 10 : null,
      byAutomation: byAutomation.rows,
      features,
      byUser: byUser.rows,
      byAction: byAction.rows,
      byDay: byDay.rows,
      recentErrors: recentErrors.rows,
      recentActivity: recentActivity.rows,
      session: sessionRow.rows[0] || null,
      inflight: queueRow.rows[0] || { queued: 0, running: 0, pending: 0 },
      users: usersTotal.rows[0] || { registered: 0, active_logins: 0 },
    };
  }

  // ── Analytics: the "is everything working?" panel ────────────────────────
  app.get('/api/admin/analytics', adminOnly, async () => buildAnalytics(7));

  // Richer KPI payload for the dashboard (boxes + charts). Same auth as analytics.
  app.get('/api/admin/kpi', {
    ...adminOnly,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { days: { type: 'integer', enum: [7, 30] } },
      },
    },
  }, async (req) => buildAnalytics(req.query.days || 7));
}
