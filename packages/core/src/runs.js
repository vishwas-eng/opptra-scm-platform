// Run lifecycle helpers - every automation action, human or scheduled, goes through these.
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

/**
 * Append one progress step to a running job, so the UI can show what is happening
 * rather than a spinner. Best-effort by design: a failed progress write must never
 * abort the actual work.
 *
 * @param {string} runUid
 * @param {{ step: string, state?: 'running'|'done'|'failed', detail?: string }} entry
 */
export async function addRunProgress(runUid, entry) {
  if (!runUid || !entry?.step) return;
  const row = {
    step: String(entry.step).slice(0, 120),
    state: entry.state || 'done',
    detail: entry.detail ? String(entry.detail).slice(0, 200) : '',
    at: new Date().toISOString(),
  };
  try {
    await query(
      `UPDATE runs SET progress = progress || $2::jsonb WHERE run_uid = $1`,
      [runUid, JSON.stringify([row])],
    );
  } catch {
    // Progress is a convenience. Never let it break the job it is describing.
  }
}
