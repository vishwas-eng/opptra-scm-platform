// Relay job queue, work the platform cannot reach, executed by an agent that can.
//
// The platform never dials into a private network. An agent already inside it polls
// outbound, claims a job, does the work through the access it already has, and posts
// the result back.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

const CLAIM_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export async function createRelayJob({ connectorId, kind, payload = {}, requestedBy = '' }) {
  const jobUid = randomUUID();
  const { rows } = await query(
    `INSERT INTO relay_jobs (job_uid, connector_id, kind, payload, requested_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING job_uid, connector_id, kind, status, created_at`,
    [jobUid, connectorId, kind, JSON.stringify(payload), requestedBy],
  );
  return rows[0];
}

/**
 * Atomically claim the oldest runnable job for a connector.
 *
 * The UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) form is what makes two
 * agents polling at once safe: each takes a different row instead of both grabbing the
 * same one. A claim that is never completed (laptop slept, VPN dropped) expires and the
 * job becomes available again rather than stranding forever.
 */
export async function claimRelayJob({ connectorId, agentId, ttlMs = CLAIM_TTL_MS }) {
  const { rows } = await query(
    `UPDATE relay_jobs SET
       status = 'claimed',
       claimed_by = $2,
       claim_expires_at = now() + ($3::int * interval '1 millisecond'),
       attempts = attempts + 1,
       updated_at = now()
     WHERE id = (
       SELECT id FROM relay_jobs
       WHERE connector_id = $1
         AND attempts < $4
         AND (status = 'pending'
              OR (status = 'claimed' AND claim_expires_at < now()))
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING job_uid, connector_id, kind, payload, attempts`,
    [connectorId, agentId, ttlMs, MAX_ATTEMPTS],
  );
  return rows[0] || null;
}

export async function completeRelayJob({ jobUid, agentId, artifacts = [], result = {}, error = '' }) {
  // Only the agent that holds the claim may complete it, so a stale agent waking up
  // after its claim expired cannot overwrite the result of whoever took over.
  const { rows } = await query(
    `UPDATE relay_jobs SET
       status = $3, artifacts = $4::jsonb, result = $5::jsonb, error = $6, updated_at = now()
     WHERE job_uid = $1 AND claimed_by = $2 AND status = 'claimed'
     RETURNING job_uid, status, attempts`,
    [
      jobUid,
      agentId,
      error ? 'failed' : 'done',
      JSON.stringify(artifacts || []),
      JSON.stringify(result || {}),
      error,
    ],
  );
  return rows[0] || null;
}

export async function getRelayJob(jobUid, { withArtifacts = false } = {}) {
  const { rows } = await query(
    `SELECT job_uid, connector_id, kind, status, payload, result, error,
            requested_by, claimed_by, attempts, created_at, updated_at
            ${withArtifacts ? ', artifacts' : ", jsonb_array_length(artifacts) AS artifact_count"}
     FROM relay_jobs WHERE job_uid = $1`,
    [jobUid],
  );
  return rows[0] || null;
}

export async function listRelayJobs({ connectorId, status, limit = 25 } = {}) {
  const where = [];
  const params = [];
  if (connectorId) { params.push(connectorId); where.push(`connector_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  params.push(Math.min(limit, 100));
  const { rows } = await query(
    `SELECT job_uid, connector_id, kind, status, error, requested_by, claimed_by,
            attempts, created_at, updated_at, jsonb_array_length(artifacts) AS artifact_count
     FROM relay_jobs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
