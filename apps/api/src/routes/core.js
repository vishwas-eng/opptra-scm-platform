// Health, session status, runs feed, current user.
import { query, listRuns } from '@opptra/core';

export default async function coreRoutes(app) {
  // Liveness/readiness — used by Docker healthcheck and monitoring. No auth, so it
  // exposes NOTHING internal (UC session detail lives behind /api/uc-session).
  app.get('/healthz', async () => {
    let db = false;
    try { await query('SELECT 1'); db = true; } catch { /* db down */ }
    return { ok: db, db, time: new Date().toISOString() };
  });

  // Public client config (the Google client id is not a secret — it's in every page).
  app.get('/api/config', async () => {
    const { config } = await import('@opptra/core');
    return { googleClientId: config().GOOGLE_CLIENT_ID };
  });

  app.get('/api/me', { preValidation: app.requireUser }, async (req) => ({ user: req.user }));

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
