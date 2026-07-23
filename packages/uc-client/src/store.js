// Session persistence backends. Production uses Postgres (survives restarts, editable
// from the Admin tab). Tests use the in-memory store.
import { query } from '@opptra/core';

export class PgSessionStore {
  async get() {
    const { rows } = await query('SELECT jsessionid, source FROM uc_session WHERE id = 1');
    return rows[0] || { jsessionid: '', source: 'none' };
  }

  async set(cookie, source, actor) {
    // A fresh cookie clears the re-login flag - the outage is over.
    await query(
      `UPDATE uc_session SET jsessionid = $1, source = $2, status = 'unknown',
        updated_by = $3, updated_at = now(), fail_count = 0,
        needs_relogin = false, relogin_since = NULL WHERE id = 1`,
      [cookie, source, actor]
    );
  }

  async markAlive() {
    await query(`UPDATE uc_session SET status = 'alive', last_ok_at = now(), last_check_at = now(),
      fail_count = 0, needs_relogin = false, relogin_since = NULL WHERE id = 1`);
  }

  async markChecked() {
    await query(`UPDATE uc_session SET last_check_at = now() WHERE id = 1`);
  }

  async markDead() {
    // Flag that a human re-login is needed; stamp the start of the outage once.
    await query(`UPDATE uc_session
      SET status = 'dead', last_check_at = now(), fail_count = fail_count + 1,
          needs_relogin = true,
          relogin_since = COALESCE(relogin_since, now())
      WHERE id = 1`);
  }

  async status() {
    const { rows } = await query(
      `SELECT status, source, facility, updated_by, updated_at, last_ok_at, last_check_at, fail_count,
              needs_relogin, relogin_since, (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE id = 1`);
    return rows[0];
  }
}

export class MemorySessionStore {
  constructor(initial = {}) {
    this.row = { jsessionid: '', source: 'none', status: 'unknown', fail_count: 0, ...initial };
  }
  async get() { return { jsessionid: this.row.jsessionid, source: this.row.source }; }
  async set(cookie, source, actor) {
    Object.assign(this.row, { jsessionid: cookie, source, status: 'unknown', updated_by: actor, fail_count: 0 });
  }
  async markAlive() { Object.assign(this.row, { status: 'alive', fail_count: 0 }); }
  async markChecked() {}
  async markDead() { this.row.status = 'dead'; this.row.fail_count += 1; }
  async status() { return { ...this.row, has_cookie: !!this.row.jsessionid }; }
}
