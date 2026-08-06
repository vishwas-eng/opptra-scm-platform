// Session persistence backends. Production uses Postgres (survives restarts, editable
// from the Admin tab). Tests use the in-memory store.
//
// Rows are keyed by instance_id ('india' | 'uae' | 'ksa' | 'staging') so each UC tenant
// keeps its own JSESSIONID — logging into staging must never overwrite India.
import { query, sealSecret, openSecret } from '@opptra/core';
import { normalizeInstanceId } from './instances.js';

export class PgSessionStore {
  constructor({ instanceId = 'india' } = {}) {
    this.instanceId = normalizeInstanceId(instanceId);
  }

  async get() {
    const { rows } = await query(
      'SELECT jsessionid, source, base_url FROM uc_session WHERE instance_id = $1',
      [this.instanceId],
    );
    const row = rows[0];
    if (!row) return { jsessionid: '', source: 'none', base_url: '' };
    return { ...row, jsessionid: openSecret(row.jsessionid) };
  }

  async set(cookie, source, actor, { baseUrl } = {}) {
    // A fresh cookie clears the re-login flag - the outage is over.
    await query(
      `INSERT INTO uc_session (instance_id, jsessionid, source, status, updated_by, updated_at,
         fail_count, needs_relogin, relogin_since, base_url)
       VALUES ($1, $2, $3, 'unknown', $4, now(), 0, false, NULL, COALESCE($5, ''))
       ON CONFLICT (instance_id) DO UPDATE SET
         jsessionid = EXCLUDED.jsessionid,
         source = EXCLUDED.source,
         status = 'unknown',
         updated_by = EXCLUDED.updated_by,
         updated_at = now(),
         fail_count = 0,
         needs_relogin = false,
         relogin_since = NULL,
         base_url = CASE
           WHEN EXCLUDED.base_url <> '' THEN EXCLUDED.base_url
           ELSE uc_session.base_url
         END`,
      [this.instanceId, sealSecret(cookie), source, actor, baseUrl || ''],
    );
  }

  async markAlive() {
    await query(
      `UPDATE uc_session SET status = 'alive', last_ok_at = now(), last_check_at = now(),
        fail_count = 0, needs_relogin = false, relogin_since = NULL
       WHERE instance_id = $1`,
      [this.instanceId],
    );
  }

  async markChecked() {
    await query(
      `UPDATE uc_session SET last_check_at = now() WHERE instance_id = $1`,
      [this.instanceId],
    );
  }

  async markDead() {
    // Flag that a human re-login is needed; stamp the start of the outage once.
    await query(
      `UPDATE uc_session
       SET status = 'dead', last_check_at = now(), fail_count = fail_count + 1,
           needs_relogin = true,
           relogin_since = COALESCE(relogin_since, now())
       WHERE instance_id = $1`,
      [this.instanceId],
    );
  }

  async status() {
    const { rows } = await query(
      `SELECT instance_id, base_url, status, source, facility, updated_by, updated_at,
              last_ok_at, last_check_at, fail_count, needs_relogin, relogin_since,
              (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE instance_id = $1`,
      [this.instanceId],
    );
    return rows[0];
  }

  /** List all instance rows (no cookie values). */
  static async listStatus() {
    const { rows } = await query(
      `SELECT instance_id, base_url, status, source, facility, updated_by, updated_at,
              last_ok_at, last_check_at, fail_count, needs_relogin, relogin_since,
              (jsessionid <> '') AS has_cookie
       FROM uc_session
       ORDER BY CASE instance_id
         WHEN 'india' THEN 1 WHEN 'uae' THEN 2 WHEN 'ksa' THEN 3 WHEN 'staging' THEN 4 ELSE 9 END`,
    );
    return rows;
  }
}

export class MemorySessionStore {
  constructor(initial = {}) {
    this.instanceId = initial.instanceId || 'memory';
    this.row = {
      jsessionid: '',
      source: 'none',
      status: 'unknown',
      fail_count: 0,
      base_url: '',
      instance_id: this.instanceId,
      ...initial,
    };
  }
  async get() {
    return { jsessionid: this.row.jsessionid, source: this.row.source, base_url: this.row.base_url || '' };
  }
  async set(cookie, source, actor, { baseUrl } = {}) {
    Object.assign(this.row, {
      jsessionid: cookie,
      source,
      status: 'unknown',
      updated_by: actor,
      fail_count: 0,
      ...(baseUrl ? { base_url: baseUrl } : {}),
    });
  }
  async markAlive() { Object.assign(this.row, { status: 'alive', fail_count: 0 }); }
  async markChecked() {}
  async markDead() { this.row.status = 'dead'; this.row.fail_count += 1; }
  async status() {
    return {
      ...this.row,
      instance_id: this.instanceId,
      has_cookie: !!this.row.jsessionid,
    };
  }
}
