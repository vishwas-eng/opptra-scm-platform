// Agent playbooks — saved sheet/drive/UC workflows (daily or manual).
//
// Schedule model: the operator picks a wall-clock time in a named zone (hour +
// schedule_minute + timezone). BullMQ's job scheduler converts via `tz`, so "9:00 IST"
// — which is 03:30 UTC and therefore unrepresentable as a whole UTC hour — is expressible.
// `hour_utc` keeps its column name for back-compat; rows created before timezones carry
// minute 0 / zone UTC and fire exactly when they always did.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

const RETURNING = `playbook_uid, title, instruction, definition, status, schedule_kind,
                   hour_utc, schedule_minute, timezone,
                   thread_uid, last_run_at, last_run_status, last_error, created_at, updated_at`;

const clampHour = (h) => Math.min(23, Math.max(0, Number(h) || 0));
const clampMinute = (m) => Math.min(59, Math.max(0, Number(m) || 0));

/**
 * Accept an IANA zone only if this Node build can actually resolve it — an unknown zone
 * would make the scheduler silently fall back and fire at the wrong hour every day.
 */
export function normalizeTimezone(tz) {
  const name = String(tz || '').trim();
  if (!name) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return 'UTC';
  }
}

/** Cron pattern + tz for a playbook row, ready for queue.upsertJobScheduler. */
export function playbookCron(pb) {
  const hour = clampHour(pb?.hour_utc ?? pb?.hourUtc ?? 3);
  const minute = clampMinute(pb?.schedule_minute ?? pb?.scheduleMinute ?? 0);
  return {
    pattern: `${minute} ${hour} * * *`,
    tz: normalizeTimezone(pb?.timezone),
  };
}

export async function createAgentPlaybook({
  userEmail,
  title = 'Daily automation',
  instruction = '',
  definition = {},
  status = 'draft',
  scheduleKind = 'manual',
  hourUtc = 3,
  scheduleMinute = 0,
  timezone = 'UTC',
  threadUid = null,
}) {
  const playbookUid = randomUUID();
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `INSERT INTO agent_playbooks
       (playbook_uid, user_email, title, instruction, definition, status, schedule_kind,
        hour_utc, schedule_minute, timezone, thread_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${RETURNING}`,
    [
      playbookUid, email, String(title).slice(0, 160), String(instruction).slice(0, 4000),
      JSON.stringify(definition || {}), status, scheduleKind,
      clampHour(hourUtc), clampMinute(scheduleMinute), normalizeTimezone(timezone), threadUid,
    ],
  );
  return rows[0];
}

export async function listAgentPlaybooks({ userEmail, limit = 50 } = {}) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT ${RETURNING}
     FROM agent_playbooks WHERE user_email = $1
     ORDER BY updated_at DESC LIMIT $2`,
    [email, Math.min(Number(limit) || 50, 100)],
  );
  return rows;
}

export async function getAgentPlaybook({ playbookUid, userEmail = null }) {
  if (userEmail) {
    const email = String(userEmail).trim().toLowerCase();
    const { rows } = await query(
      `SELECT * FROM agent_playbooks WHERE playbook_uid = $1 AND user_email = $2`,
      [playbookUid, email],
    );
    return rows[0] || null;
  }
  const { rows } = await query(`SELECT * FROM agent_playbooks WHERE playbook_uid = $1`, [playbookUid]);
  return rows[0] || null;
}

export async function updateAgentPlaybook(playbookUid, userEmail, patch = {}) {
  const current = await getAgentPlaybook({ playbookUid, userEmail });
  if (!current) return null;
  const title = patch.title ?? current.title;
  const instruction = patch.instruction ?? current.instruction;
  const definition = patch.definition ?? current.definition;
  const status = patch.status ?? current.status;
  const scheduleKind = patch.scheduleKind ?? current.schedule_kind;
  const hourUtc = patch.hourUtc ?? current.hour_utc;
  const scheduleMinute = patch.scheduleMinute ?? current.schedule_minute;
  const timezone = patch.timezone ?? current.timezone;
  const { rows } = await query(
    `UPDATE agent_playbooks SET
       title = $3, instruction = $4, definition = $5, status = $6,
       schedule_kind = $7, hour_utc = $8, schedule_minute = $9, timezone = $10, updated_at = now()
     WHERE playbook_uid = $1 AND user_email = $2
     RETURNING ${RETURNING}`,
    [
      playbookUid, String(userEmail).trim().toLowerCase(),
      String(title).slice(0, 160), String(instruction).slice(0, 4000),
      JSON.stringify(definition), status, scheduleKind,
      clampHour(hourUtc), clampMinute(scheduleMinute), normalizeTimezone(timezone),
    ],
  );
  return rows[0] || null;
}

export async function markPlaybookRun(playbookUid, { ok, error = null }) {
  await query(
    `UPDATE agent_playbooks SET last_run_at = now(), last_run_status = $2, last_error = $3, updated_at = now()
     WHERE playbook_uid = $1`,
    [playbookUid, ok ? 'succeeded' : 'failed', error],
  );
}

/**
 * Active daily playbooks whose OWNER is still an active user.
 *
 * Deactivating a user correctly cuts their HTTP access, but their scheduled playbook has
 * no requesting user to authorize — the worker re-registers it on every boot and it keeps
 * writing to sheets under a departed employee's stored Google grant, with no UI left for
 * them to pause it. Ownership is therefore re-checked here, on every re-registration.
 */
export async function listActiveDailyPlaybooks() {
  const { rows } = await query(
    `SELECT p.playbook_uid, p.user_email, p.title, p.definition, p.hour_utc,
            p.schedule_minute, p.timezone, p.schedule_kind, p.status
     FROM agent_playbooks p
     JOIN users u ON lower(u.email) = lower(p.user_email)
     WHERE p.status = 'active' AND p.schedule_kind = 'daily' AND u.is_active`,
  );
  return rows;
}

/** True when the playbook's owner is still an active user (checked at run time too). */
export async function playbookOwnerActive(userEmail) {
  const { rows } = await query(
    'SELECT is_active FROM users WHERE lower(email) = lower($1)',
    [String(userEmail || '').trim()],
  );
  return !!rows[0]?.is_active;
}
