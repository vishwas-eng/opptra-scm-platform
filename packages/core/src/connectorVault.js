// Generic connector credential vault. Secrets stay server-side; callers never get the
// secret unless they explicitly ask via getConnectorSecret (worker / invoke path only).
// secret_enc is sealed with secretBox (AES-256-GCM), never store the raw value.
import { query } from './db.js';
import { sealSecret, openSecret, isSealed } from './secretBox.js';

function owner(ownerKey = 'shared') {
  return String(ownerKey || 'shared').trim().toLowerCase() || 'shared';
}

/** Metadata only, never includes secret_enc. */
export async function getConnectorCredentialMeta(connectorId, ownerKey = 'shared') {
  const { rows } = await query(
    `SELECT connector_id, owner_key, auth_kind, meta, status, source, updated_by, updated_at,
            last_ok_at, last_check_at, fail_count,
            (secret_enc IS NOT NULL AND secret_enc <> '') AS has_secret
     FROM connector_credentials WHERE connector_id = $1 AND owner_key = $2`,
    [connectorId, owner(ownerKey)],
  );
  return rows[0] || null;
}

export async function listConnectorCredentialMeta({ connectorIds } = {}) {
  if (connectorIds?.length) {
    const { rows } = await query(
      `SELECT connector_id, owner_key, auth_kind, meta, status, source, updated_by, updated_at,
              last_ok_at, last_check_at, fail_count,
              (secret_enc IS NOT NULL AND secret_enc <> '') AS has_secret
       FROM connector_credentials WHERE connector_id = ANY($1::text[])`,
      [connectorIds],
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT connector_id, owner_key, auth_kind, meta, status, source, updated_by, updated_at,
            last_ok_at, last_check_at, fail_count,
            (secret_enc IS NOT NULL AND secret_enc <> '') AS has_secret
     FROM connector_credentials`,
  );
  return rows;
}

/** Worker/invoke only, returns the OPENED secret. Never send to browser. */
export async function getConnectorSecret(connectorId, ownerKey = 'shared') {
  const { rows } = await query(
    `SELECT secret_enc, auth_kind, meta, status FROM connector_credentials
     WHERE connector_id = $1 AND owner_key = $2`,
    [connectorId, owner(ownerKey)],
  );
  const row = rows[0];
  if (!row) return null;
  const { secret_enc, ...rest } = row;
  return { ...rest, secret: openSecret(secret_enc) };
}

export async function setConnectorCredential({
  connectorId,
  ownerKey = 'shared',
  authKind = 'session',
  secret,
  meta = {},
  source = 'paste',
  updatedBy = '',
  status = 'configured',
}) {
  const { rows } = await query(
    `INSERT INTO connector_credentials
       (connector_id, owner_key, auth_kind, secret_enc, meta, status, source, updated_by, updated_at, fail_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 0)
     ON CONFLICT (connector_id, owner_key) DO UPDATE SET
       auth_kind = EXCLUDED.auth_kind,
       secret_enc = EXCLUDED.secret_enc,
       meta = EXCLUDED.meta,
       status = EXCLUDED.status,
       source = EXCLUDED.source,
       updated_by = EXCLUDED.updated_by,
       updated_at = now(),
       fail_count = 0
     RETURNING connector_id, owner_key, auth_kind, status, source, updated_at,
               (secret_enc <> '') AS has_secret`,
    [
      connectorId,
      owner(ownerKey),
      authKind,
      sealSecret(secret),
      JSON.stringify(meta || {}),
      status,
      source,
      updatedBy,
    ],
  );
  return rows[0];
}

export async function clearConnectorCredential(connectorId, ownerKey = 'shared') {
  await query(
    `DELETE FROM connector_credentials WHERE connector_id = $1 AND owner_key = $2`,
    [connectorId, owner(ownerKey)],
  );
}

export async function markConnectorAlive(connectorId, ownerKey = 'shared') {
  await query(
    `UPDATE connector_credentials SET status = 'alive', last_ok_at = now(), last_check_at = now(),
     fail_count = 0 WHERE connector_id = $1 AND owner_key = $2`,
    [connectorId, owner(ownerKey)],
  );
}

/**
 * One-shot boot backfill: seal any legacy plaintext secrets sitting at rest
 * (connector vault + UC session cookies). Idempotent, sealed rows are skipped
 * by the prefix check, so calling this on every worker boot costs one SELECT.
 * @returns {{ credentials: number, sessions: number }} rows sealed
 */
export async function sealPlaintextSecretsAtRest() {
  const sealed = { credentials: 0, sessions: 0 };
  const creds = await query(
    `SELECT connector_id, owner_key, secret_enc FROM connector_credentials WHERE secret_enc <> ''`,
  );
  for (const row of creds.rows) {
    if (isSealed(row.secret_enc)) continue;
    await query(
      `UPDATE connector_credentials SET secret_enc = $3
       WHERE connector_id = $1 AND owner_key = $2`,
      [row.connector_id, row.owner_key, sealSecret(row.secret_enc)],
    );
    sealed.credentials += 1;
  }
  const sessions = await query(`SELECT instance_id, jsessionid FROM uc_session WHERE jsessionid <> ''`);
  for (const row of sessions.rows) {
    if (isSealed(row.jsessionid)) continue;
    await query(
      `UPDATE uc_session SET jsessionid = $2 WHERE instance_id = $1`,
      [row.instance_id, sealSecret(row.jsessionid)],
    );
    sealed.sessions += 1;
  }
  return sealed;
}

export async function markConnectorDead(connectorId, ownerKey = 'shared') {
  await query(
    `UPDATE connector_credentials SET status = 'dead', last_check_at = now(),
     fail_count = fail_count + 1 WHERE connector_id = $1 AND owner_key = $2`,
    [connectorId, owner(ownerKey)],
  );
}
