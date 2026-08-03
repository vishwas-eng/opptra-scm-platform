// Agent playbooks — saved sheet/drive/UC workflows (daily or manual).
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export async function createAgentPlaybook({
  userEmail,
  title = 'Daily automation',
  instruction = '',
  definition = {},
  status = 'draft',
  scheduleKind = 'manual',
  hourUtc = 3,
  threadUid = null,
}) {
  const playbookUid = randomUUID();
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `INSERT INTO agent_playbooks
       (playbook_uid, user_email, title, instruction, definition, status, schedule_kind, hour_utc, thread_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING playbook_uid, title, instruction, definition, status, schedule_kind, hour_utc,
               thread_uid, last_run_at, last_run_status, created_at, updated_at`,
    [
      playbookUid, email, String(title).slice(0, 160), String(instruction).slice(0, 4000),
      JSON.stringify(definition || {}), status, scheduleKind,
      Math.min(23, Math.max(0, Number(hourUtc) || 3)), threadUid,
    ],
  );
  return rows[0];
}

export async function listAgentPlaybooks({ userEmail, limit = 50 } = {}) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT playbook_uid, title, instruction, definition, status, schedule_kind, hour_utc,
            thread_uid, last_run_at, last_run_status, last_error, created_at, updated_at
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
  const { rows } = await query(
    `UPDATE agent_playbooks SET
       title = $3, instruction = $4, definition = $5, status = $6,
       schedule_kind = $7, hour_utc = $8, updated_at = now()
     WHERE playbook_uid = $1 AND user_email = $2
     RETURNING playbook_uid, title, instruction, definition, status, schedule_kind, hour_utc,
               thread_uid, last_run_at, last_run_status, last_error, created_at, updated_at`,
    [
      playbookUid, String(userEmail).trim().toLowerCase(),
      String(title).slice(0, 160), String(instruction).slice(0, 4000),
      JSON.stringify(definition), status, scheduleKind,
      Math.min(23, Math.max(0, Number(hourUtc) || 3)),
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

export async function listActiveDailyPlaybooks() {
  const { rows } = await query(
    `SELECT playbook_uid, user_email, title, definition, hour_utc, schedule_kind, status
     FROM agent_playbooks WHERE status = 'active' AND schedule_kind = 'daily'`,
  );
  return rows;
}
