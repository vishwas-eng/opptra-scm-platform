// Agent chat persistence (threads + messages + per-user connector enablement).
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export async function createAgentThread({ userEmail, title = 'New chat' }) {
  const threadUid = randomUUID();
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `INSERT INTO agent_threads (thread_uid, user_email, title)
     VALUES ($1, $2, $3) RETURNING id, thread_uid, title, created_at, updated_at`,
    [threadUid, email, String(title || 'New chat').slice(0, 120)],
  );
  return rows[0];
}

export async function listAgentThreads({ userEmail, limit = 40 } = {}) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT thread_uid, title, created_at, updated_at
     FROM agent_threads WHERE user_email = $1
     ORDER BY updated_at DESC LIMIT $2`,
    [email, Math.min(Number(limit) || 40, 100)],
  );
  return rows;
}

export async function getAgentThread({ threadUid, userEmail }) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT id, thread_uid, user_email, title, created_at, updated_at
     FROM agent_threads WHERE thread_uid = $1 AND user_email = $2`,
    [threadUid, email],
  );
  return rows[0] || null;
}

export async function touchAgentThread(threadId, title) {
  if (title) {
    await query(
      `UPDATE agent_threads SET updated_at = now(), title = $2 WHERE id = $1`,
      [threadId, String(title).slice(0, 120)],
    );
  } else {
    await query(`UPDATE agent_threads SET updated_at = now() WHERE id = $1`, [threadId]);
  }
}

export async function addAgentMessage({
  threadId, role, content = '', toolCalls = [], meta = {},
}) {
  const { rows } = await query(
    `INSERT INTO agent_messages (thread_id, role, content, tool_calls, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, role, content, tool_calls, meta, created_at`,
    [
      threadId,
      role,
      String(content || ''),
      JSON.stringify(toolCalls || []),
      JSON.stringify(meta || {}),
    ],
  );
  await query(`UPDATE agent_threads SET updated_at = now() WHERE id = $1`, [threadId]);
  return rows[0];
}

export async function listAgentMessages({ threadId, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT id, role, content, tool_calls, meta, created_at
     FROM agent_messages WHERE thread_id = $1
     ORDER BY id ASC LIMIT $2`,
    [threadId, Math.min(Number(limit) || 200, 500)],
  );
  return rows;
}

export async function getConnectorState(userEmail, connectorId) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT connector_id, enabled, connected_at, disconnected_at, meta
     FROM agent_connector_state WHERE user_email = $1 AND connector_id = $2`,
    [email, connectorId],
  );
  return rows[0] || null;
}

export async function listConnectorStates(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT connector_id, enabled, connected_at, disconnected_at, meta
     FROM agent_connector_state WHERE user_email = $1`,
    [email],
  );
  return rows;
}

export async function setConnectorEnabled({ userEmail, connectorId, enabled, meta = {} }) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `INSERT INTO agent_connector_state (user_email, connector_id, enabled, connected_at, disconnected_at, meta)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, CASE WHEN $3 THEN NULL ELSE now() END, $4)
     ON CONFLICT (user_email, connector_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       connected_at = CASE WHEN EXCLUDED.enabled THEN now() ELSE agent_connector_state.connected_at END,
       disconnected_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE now() END,
       meta = COALESCE(EXCLUDED.meta, agent_connector_state.meta)
     RETURNING connector_id, enabled, connected_at, disconnected_at, meta`,
    [email, connectorId, !!enabled, JSON.stringify(meta || {})],
  );
  return rows[0];
}
