// Capture-session persistence. Entries arriving here are ALREADY redacted by the route
// (packages/capture); this module never sees live session material, that is sealed
// into connector_credentials before storage.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

const MAX_ENTRIES = 4000; // one login + a few screens is ~500; 4000 is a generous ceiling

export async function createCaptureSession({ connectorId, label = '', ownerEmail }) {
  const captureUid = randomUUID();
  const { rows } = await query(
    `INSERT INTO capture_sessions (capture_uid, connector_id, label, owner_email)
     VALUES ($1, $2, $3, $4)
     RETURNING capture_uid, connector_id, label, status, created_at`,
    [captureUid, connectorId, label, ownerEmail],
  );
  return rows[0];
}

/**
 * Append redacted entries. Returns the running count. Caps total entries so a runaway
 * recorder cannot fill the table, the surplus is dropped and reported, never silently
 * lost (a capture that "looks complete" but is missing the flow you need is worse than
 * one that says it truncated).
 */
export async function appendCaptureEntries({ captureUid, ownerEmail, entries = [] }) {
  const { rows } = await query(
    `SELECT id, entry_count FROM capture_sessions
     WHERE capture_uid = $1 AND owner_email = $2 AND status = 'recording'`,
    [captureUid, ownerEmail],
  );
  if (!rows.length) return null;

  const room = Math.max(0, MAX_ENTRIES - rows[0].entry_count);
  const accepted = entries.slice(0, room);
  const dropped = entries.length - accepted.length;

  if (accepted.length) {
    await query(
      `UPDATE capture_sessions
       SET entries = entries || $2::jsonb,
           entry_count = entry_count + $3,
           updated_at = now()
       WHERE id = $1`,
      [rows[0].id, JSON.stringify(accepted), accepted.length],
    );
  }
  return { accepted: accepted.length, dropped, total: rows[0].entry_count + accepted.length };
}

export async function finishCaptureSession({ captureUid, ownerEmail, analysis, sessionSaved = false, error = '' }) {
  const { rows } = await query(
    `UPDATE capture_sessions
     SET status = $3, analysis = $4::jsonb, session_saved = $5, error = $6, updated_at = now()
     WHERE capture_uid = $1 AND owner_email = $2
     RETURNING capture_uid, connector_id, label, status, entry_count, session_saved, analysis, created_at`,
    [
      captureUid, ownerEmail,
      error ? 'failed' : 'ready',
      JSON.stringify(analysis || {}),
      sessionSaved,
      error,
    ],
  );
  return rows[0] || null;
}

/** List captures WITHOUT their entry payloads (those are large). */
export async function listCaptureSessions({ connectorId, ownerEmail, limit = 25 } = {}) {
  const where = [];
  const params = [];
  if (connectorId) { params.push(connectorId); where.push(`connector_id = $${params.length}`); }
  if (ownerEmail) { params.push(ownerEmail); where.push(`owner_email = $${params.length}`); }
  params.push(Math.min(limit, 100));
  const { rows } = await query(
    `SELECT capture_uid, connector_id, label, status, owner_email, entry_count,
            session_saved, error, created_at, updated_at,
            analysis -> 'summary' AS summary
     FROM capture_sessions
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getCaptureSession(captureUid, { withEntries = false } = {}) {
  const { rows } = await query(
    `SELECT capture_uid, connector_id, label, status, owner_email, entry_count,
            session_saved, error, analysis, created_at, updated_at
            ${withEntries ? ', entries' : ''}
     FROM capture_sessions WHERE capture_uid = $1`,
    [captureUid],
  );
  return rows[0] || null;
}

export async function deleteCaptureSession(captureUid) {
  await query('DELETE FROM capture_sessions WHERE capture_uid = $1', [captureUid]);
}
