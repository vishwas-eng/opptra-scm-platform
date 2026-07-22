// Health, session status, runs feed, current user.
import { config, query, listRuns } from '@opptra/core';

export default async function coreRoutes(app) {
  // Liveness/readiness — used by Docker healthcheck and monitoring. No auth, so it
  // exposes NOTHING internal (UC session detail lives behind /api/uc-session).
  app.get('/healthz', async () => {
    let db = false;
    try { await query('SELECT 1'); db = true; } catch { /* db down */ }
    return { ok: db, db, time: new Date().toISOString() };
  });

  // Public client config (the Google client id is not a secret — it's in every page).
  app.get('/api/config', async () => ({ googleClientId: config().GOOGLE_CLIENT_ID, devLogin: !config().isProd }));

  app.get('/api/me', { preValidation: app.requireUser }, async (req) => ({ user: req.user }));

  // Which integrations are configured — drives the "setup required" state on the
  // Google/Vinculum-dependent automation tabs so nothing looks missing, just gated.
  app.get('/api/integrations', { preValidation: app.requireUser }, async () => {
    const c = config();
    return {
      google: !!(c.GOOGLE_SA_KEY_JSON && c.GOOGLE_DELEGATED_USER),
      masterSheet: !!c.MASTER_SHEET_ID,
      vinculum: !!(c.VINCULUM_BASE_URL && c.VINCULUM_USER && c.VINCULUM_PASS),
    };
  });

  app.get('/api/uc-session', { preValidation: app.requireUser }, async () => {
    const { rows } = await query(
      `SELECT status, source, updated_by, updated_at, last_ok_at, last_check_at, fail_count,
              needs_relogin, relogin_since, (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE id = 1`);
    return rows[0];
  });

  app.get('/api/runs', {
    preValidation: app.requireUser,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          user: { type: 'string' },
          automation: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const rows = await listRuns({
      limit: req.query.limit || 50,
      userEmail: req.query.user || null,
      automation: req.query.automation || null,
    });
    return { runs: rows };
  });

  // Dashboard stats for every signed-in user (the header cards). Lightweight counts,
  // not the admin analytics panel.
  app.get('/api/dashboard', { preValidation: app.requireUser }, async () => {
    const [inflight, week] = await Promise.all([
      query(`SELECT count(*)::int n FROM runs WHERE status IN ('queued','running','pending_retry')`),
      query(`SELECT status, count(*)::int n FROM runs WHERE created_at > now() - interval '7 days' GROUP BY status`),
    ]);
    const byStatus = Object.fromEntries(week.rows.map((r) => [r.status, r.n]));
    const total = week.rows.reduce((s, r) => s + r.n, 0);
    return {
      inflight: inflight.rows[0].n,
      week: { total, succeeded: byStatus.succeeded || 0, failed: byStatus.failed || 0 },
    };
  });
}
