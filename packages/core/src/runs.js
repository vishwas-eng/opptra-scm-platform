// Run lifecycle helpers — every automation action, human or scheduled, goes through these.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export async function createRun({ userEmail, ownerEmail = '', automation, action, input = {} }) {
  const runUid = randomUUID();
  const { rows } = await query(
    `INSERT INTO runs (run_uid, user_email, owner_email, automation, action, input)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, run_uid`,
    [runUid, userEmail, ownerEmail, automation, action, JSON.stringify(input)]
  );
  return rows[0];
}

export async function markRunning(runUid) {
  await query(`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE run_uid = $1`, [runUid]);
}

export async function markPendingRetry(runUid, result) {
  await query(`UPDATE runs SET status = 'pending_retry', result = $2 WHERE run_uid = $1`,
    [runUid, JSON.stringify(result ?? null)]);
}

export async function finishRun(runUid, { ok, result = null, error = null, artifacts = [] }) {
  await query(
    `UPDATE runs SET status = $2, result = $3, error = $4, artifacts = $5, finished_at = now() WHERE run_uid = $1`,
    [runUid, ok ? 'succeeded' : 'failed', JSON.stringify(result), error, JSON.stringify(artifacts)]
  );
}

export async function listRuns({ limit = 50, userEmail = null, automation = null } = {}) {
  const cond = [];
  const params = [];
  if (userEmail) { params.push(userEmail); cond.push(`user_email = $${params.length}`); }
  if (automation) { params.push(automation); cond.push(`automation = $${params.length}`); }
  params.push(Math.min(Number(limit) || 50, 200));
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT run_uid, user_email, automation, action, input, status, result, error, created_at, started_at, finished_at
     FROM runs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

export async function audit(actor, event, detail = {}) {
  await query('INSERT INTO audit_log (actor, event, detail) VALUES ($1, $2, $3)', [actor, event, JSON.stringify(detail)]);
}
