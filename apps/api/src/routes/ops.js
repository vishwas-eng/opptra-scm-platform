// Machine-readable ops summary for Cursor / Slack agents.
// Auth: shared secret OPS_AGENT_TOKEN via Authorization: Bearer … or X-Ops-Token.
// No Google SSO. Does NOT expose cookies, JSESSIONID, or other secrets.
import { timingSafeEqual } from 'node:crypto';
import { config, query } from '@opptra/core';

function providedOpsToken(req) {
  const hdr = String(req.headers['x-ops-token'] || '').trim();
  if (hdr) return hdr;
  const auth = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function opsTokenMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function requireOpsAgent(req, reply) {
  const expected = config().OPS_AGENT_TOKEN;
  if (!expected) {
    return reply.code(503).send({ error: 'ops agent not configured (set OPS_AGENT_TOKEN on the server)' });
  }
  if (!opsTokenMatches(providedOpsToken(req), expected)) {
    return reply.code(401).send({ error: 'invalid ops token' });
  }
}

export default async function opsRoutes(app) {
  app.get('/api/ops/summary', {
    preValidation: requireOpsAgent,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async () => {
    const since = "now() - interval '7 days'";
    const [totals, byAutomation, recentErrors, sessionRow, queueRow] = await Promise.all([
      query(`SELECT status, count(*)::int n FROM runs WHERE created_at > ${since} GROUP BY status`),
      query(`SELECT automation,
                count(*)::int total,
                count(*) FILTER (WHERE status='succeeded')::int ok,
                count(*) FILTER (WHERE status='failed')::int failed,
                count(*) FILTER (WHERE status IN ('queued','running','pending_retry'))::int active
              FROM runs WHERE created_at > ${since} GROUP BY automation ORDER BY total DESC`),
      query(`SELECT run_uid, user_email, automation, action, error, status, created_at, finished_at
              FROM runs WHERE status='failed' AND created_at > ${since}
              ORDER BY finished_at DESC NULLS LAST LIMIT 25`),
      query(`SELECT status, source, needs_relogin, relogin_since, last_ok_at, last_check_at, fail_count,
                (jsessionid <> '') AS has_cookie FROM uc_session WHERE id = 1`),
      query(`SELECT count(*) FILTER (WHERE status='queued')::int queued,
                     count(*) FILTER (WHERE status='running')::int running,
                     count(*) FILTER (WHERE status='pending_retry')::int pending
              FROM runs WHERE created_at > ${since}`),
    ]);

    const totalsMap = Object.fromEntries(totals.rows.map((r) => [r.status, r.n]));
    const weekTotal = totals.rows.reduce((s, r) => s + r.n, 0);

    return {
      ok: true,
      windowDays: 7,
      generatedAt: new Date().toISOString(),
      week: {
        total: weekTotal,
        succeeded: totalsMap.succeeded || 0,
        failed: totalsMap.failed || 0,
        byStatus: totalsMap,
      },
      inflight: queueRow.rows[0] || { queued: 0, running: 0, pending: 0 },
      byAutomation: byAutomation.rows,
      recentFailures: recentErrors.rows,
      session: sessionRow.rows[0] || null,
    };
  });
}
