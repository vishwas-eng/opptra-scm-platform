// Health, session status, runs feed, current user.
import { query, listRuns } from '@opptra/core';

export default async function coreRoutes(app) {
  // Liveness/readiness — used by Docker healthcheck and monitoring. No auth (no secrets).
  app.get('/healthz', async () => {
    const checks = { db: false, ucSession: 'unknown' };
    try {
      const { rows } = await query(`SELECT status, last_ok_at FROM uc_session WHERE id = 1`);
      checks.db = true;
      checks.ucSession = rows[0]?.status || 'unknown';
      checks.ucLastOkAt = rows[0]?.last_ok_at || null;
    } catch { /* db down */ }
    const ok = checks.db;
    return { ok, ...checks, time: new Date().toISOString() };
  });

  // Public client config (the Google client id is not a secret — it's in every page).
  app.get('/api/config', async () => {
    const { config } = await import('@opptra/core');
    return { googleClientId: config().GOOGLE_CLIENT_ID };
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (req) => ({ user: req.user }));

  app.get('/api/uc-session', { preHandler: app.requireUser }, async () => {
    const { rows } = await query(
      `SELECT status, source, updated_by, updated_at, last_ok_at, last_check_at, fail_count,
              (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE id = 1`);
    return rows[0];
  });

  app.get('/api/runs', {
    preHandler: app.requireUser,
    schema: {
      querystring: {
        type: 'object',
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
}
