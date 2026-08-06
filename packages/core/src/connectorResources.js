// Bound connector resources — specific Sheets / Drive items for Agent tools.
//
// Failures carry `code` + `retryable` matching @opptra/connectors-sdk's taxonomy
// (NOT_BOUND / INVALID_INPUT). The codes are literals rather than an import because core
// must not depend on the connector SDK — but they ARE part of that contract: these are
// the most common agent failures, and callers branch on `code`, not on the prose.
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

const KIND_BY_CONNECTOR = {
  'google-sheets': new Set(['spreadsheet']),
  'google-drive': new Set(['drive_folder', 'drive_file']),
};

/** Extract Google spreadsheet / Drive folder / file id from URL or raw id. */
export function parseGoogleResourceRef(raw, preferredKind = null) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const sheet = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (sheet) return { kind: 'spreadsheet', externalId: sheet[1] };

  const folder = s.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (folder) return { kind: 'drive_folder', externalId: folder[1] };

  const file = s.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (file) return { kind: 'drive_file', externalId: file[1] };

  const openId = s.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (openId) {
    const id = openId[1];
    const kind = preferredKind === 'spreadsheet' ? 'spreadsheet'
      : preferredKind === 'drive_folder' ? 'drive_folder'
        : preferredKind === 'drive_file' ? 'drive_file'
          : 'drive_file';
    return { kind, externalId: id };
  }

  // Raw id (Google ids are typically 25–60+ chars of alnum/_/-)
  if (/^[a-zA-Z0-9-_]{10,128}$/.test(s)) {
    const kind = preferredKind || 'spreadsheet';
    return { kind, externalId: s };
  }
  return null;
}

function publicRow(row) {
  if (!row) return null;
  return {
    resourceUid: row.resource_uid,
    connectorId: row.connector_id,
    kind: row.kind,
    name: row.name,
    externalId: row.external_id,
    meta: row.meta || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnectorResources({
  userEmail, connectorId = null, kind = null, limit = 100,
} = {}) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return [];
  const lim = Math.min(Number(limit) || 100, 200);
  let sql = `SELECT resource_uid, connector_id, kind, name, external_id, meta, created_at, updated_at
             FROM connector_resources WHERE user_email = $1`;
  const params = [email];
  if (connectorId) {
    params.push(connectorId);
    sql += ` AND connector_id = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  params.push(lim);
  sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows.map(publicRow);
}

export async function getConnectorResource({ userEmail, resourceUid }) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT resource_uid, connector_id, kind, name, external_id, meta, created_at, updated_at
     FROM connector_resources WHERE user_email = $1 AND resource_uid = $2`,
    [email, resourceUid],
  );
  return publicRow(rows[0]);
}

export async function findConnectorResourceByExternal({
  userEmail, connectorId, externalId,
}) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `SELECT resource_uid, connector_id, kind, name, external_id, meta, created_at, updated_at
     FROM connector_resources
     WHERE user_email = $1 AND connector_id = $2 AND external_id = $3`,
    [email, connectorId, String(externalId || '').trim()],
  );
  return publicRow(rows[0]);
}

/**
 * Resolve a sheet/drive target for Agent tools.
 * Accepts resourceUid, or externalId that is already bound for this user.
 */
export async function resolveBoundResource({
  userEmail,
  connectorId,
  resourceUid = null,
  externalId = null,
  kinds = null,
}) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (resourceUid) {
    const r = await getConnectorResource({ userEmail: email, resourceUid });
    if (!r) {
      return {
        ok: false, code: 'NOT_BOUND', retryable: false,
        error: 'Unknown resourceUid — bind it on Connectors first.', bindRequired: true,
      };
    }
    if (connectorId && r.connectorId !== connectorId) {
      return {
        ok: false, code: 'INVALID_INPUT', retryable: false,
        error: `Resource belongs to ${r.connectorId}, not ${connectorId}.`,
      };
    }
    if (kinds && !kinds.includes(r.kind)) {
      return {
        ok: false, code: 'INVALID_INPUT', retryable: false,
        error: `Resource kind ${r.kind} not allowed here (need ${kinds.join('|')}).`,
      };
    }
    return { ok: true, resource: r };
  }
  const ext = String(externalId || '').trim();
  if (!ext) {
    return {
      ok: false,
      code: 'NOT_BOUND',
      retryable: false,
      error: 'Pass resourceId (bound) or a spreadsheetId/folderId that you already bound under Connectors.',
      bindRequired: true,
    };
  }
  const r = await findConnectorResourceByExternal({
    userEmail: email,
    connectorId,
    externalId: ext,
  });
  if (!r) {
    return {
      ok: false,
      code: 'NOT_BOUND',
      retryable: false,
      error: `Not bound: ${ext}. Add it under Connectors → ${connectorId === 'google-sheets' ? 'Google Sheets' : 'Google Drive'} first.`,
      bindRequired: true,
      externalId: ext,
    };
  }
  if (kinds && !kinds.includes(r.kind)) {
    return {
      ok: false, code: 'INVALID_INPUT', retryable: false,
      error: `Resource kind ${r.kind} not allowed here.`,
    };
  }
  return { ok: true, resource: r };
}

export async function createConnectorResource({
  userEmail,
  connectorId,
  kind,
  name,
  externalId,
  meta = {},
}) {
  const email = String(userEmail || '').trim().toLowerCase();
  const allowed = KIND_BY_CONNECTOR[connectorId];
  if (!allowed) throw Object.assign(new Error(`Resources not supported for ${connectorId}`), { code: 'UNSUPPORTED' });
  if (!allowed.has(kind)) {
    throw Object.assign(
      new Error(`kind ${kind} invalid for ${connectorId} (allowed: ${[...allowed].join(', ')})`),
      { code: 'BAD_KIND' },
    );
  }
  const ext = String(externalId || '').trim();
  if (!ext || ext.length < 10) {
    throw Object.assign(new Error('externalId required (spreadsheet / folder / file id)'), { code: 'BAD_ID' });
  }
  const label = String(name || '').trim().slice(0, 160) || ext;
  const uid = randomUUID();
  const { rows } = await query(
    `INSERT INTO connector_resources
       (resource_uid, user_email, connector_id, kind, name, external_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_email, connector_id, external_id) DO UPDATE SET
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       meta = COALESCE(EXCLUDED.meta, connector_resources.meta),
       updated_at = now()
     RETURNING resource_uid, connector_id, kind, name, external_id, meta, created_at, updated_at`,
    [uid, email, connectorId, kind, label, ext, JSON.stringify(meta || {})],
  );
  return publicRow(rows[0]);
}

export async function deleteConnectorResource({ userEmail, resourceUid }) {
  const email = String(userEmail || '').trim().toLowerCase();
  const { rows } = await query(
    `DELETE FROM connector_resources
     WHERE user_email = $1 AND resource_uid = $2
     RETURNING resource_uid`,
    [email, resourceUid],
  );
  return !!rows[0];
}

export async function deleteConnectorResourcesForUser(userEmail, connectorId = null) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (connectorId) {
    await query(
      `DELETE FROM connector_resources WHERE user_email = $1 AND connector_id = $2`,
      [email, connectorId],
    );
  } else {
    await query(`DELETE FROM connector_resources WHERE user_email = $1`, [email]);
  }
}
