// SessionManager - owner of one Unicommerce JSESSIONID for a single instance.
//
// Design contract (do not weaken):
//  1. ONE process talks to UC with this session (the worker). The cookie lives in
//     Postgres (uc_session row keyed by instance_id) so it survives restarts and
//     can be updated from the Admin tab without clobbering other tenants.
//  2. Session death = HTTP 401 / login redirect / USER_NOT_LOGGED_IN only.
//     `successful:false` bodies are business responses, not death.
//  3. On death: refresh behind a mutex. Strategies, in order:
//        a. 'scripted-login'  - whitelisted-account login (enabled once the login
//                               HAR is captured; see loginScripted()).
//        b. give up loudly    - mark dead + alert; Admin tab shows a red banner and
//                               accepts a pasted cookie as the manual bridge.
//  4. Keep-alive (worker cron) pings each instance independently.
import { logger, alert as defaultAlert } from '@opptra/core';
import { SessionError } from './errors.js';
import { PgSessionStore } from './store.js';
import { normalizeInstanceId } from './instances.js';

export class SessionManager {
  #store; #alert;
  #cookie = '';
  #loaded = false;
  #refreshing = null;
  /** Optional scripted-login implementation, injected when available. */
  loginScripted = null;
  /** Vault key: india | uae | staging */
  instanceId;

  constructor({
    overrideCookie = '',
    store = null,
    alertFn = null,
    instanceId = 'india',
  } = {}) {
    this.instanceId = normalizeInstanceId(instanceId);
    this._override = (overrideCookie || '').trim().replace(/^JSESSIONID=/i, '');
    this.#store = store || new PgSessionStore({ instanceId: this.instanceId });
    this.#alert = alertFn || defaultAlert;
  }

  /** Load cookie: env override wins on first boot (and is persisted), else DB row. */
  async load() {
    const row = await this.#store.get();
    if (this._override && this._override !== row.jsessionid) {
      await this.setCookie(this._override, 'override', 'env');
    } else {
      this.#cookie = row.jsessionid || '';
    }
    this.#loaded = true;
    logger.info(
      { instanceId: this.instanceId, hasCookie: !!this.#cookie, source: row.source },
      'uc session loaded',
    );
  }

  async getCookie() {
    if (!this.#loaded) await this.load();
    // If we have no cookie in memory, the store may have gained one (admin pasted it in
    // the API process). Re-read before giving up so a first paste works immediately.
    if (!this.#cookie) await this.reload();
    if (!this.#cookie) {
      throw new SessionError(
        `no UC session available for ${this.instanceId}. Paste one in Admin (select instance) or configure scripted login.`,
      );
    }
    return this.#cookie;
  }

  /** Re-read the cookie from the store. The admin paste happens in the API process, so
   *  the worker's SessionManager must reload to see it. Returns true if it changed.
   *  On the very first call it runs load(), which applies the env override (a hard-coded
   *  UC_JSESSIONID_OVERRIDE) - otherwise reload would mark loaded and skip it. */
  async reload() {
    if (!this.#loaded) { await this.load(); return true; }
    const row = await this.#store.get();
    const cookie = row.jsessionid || '';
    if (cookie === this.#cookie) return false;
    this.#cookie = cookie;
    logger.info(
      { instanceId: this.instanceId, source: row.source, hasCookie: !!cookie },
      'uc session cookie reloaded from store',
    );
    return true;
  }

  /** Store a new cookie (admin paste, env override, or scripted login result). */
  async setCookie(raw, source, actor, { baseUrl } = {}) {
    const cookie = String(raw || '').trim().replace(/^JSESSIONID=/i, '');
    if (!cookie) throw new SessionError('empty session cookie');
    this.#cookie = cookie;
    this.#loaded = true;
    await this.#store.set(cookie, source, actor, { baseUrl });
    logger.info({ instanceId: this.instanceId, source, actor }, 'uc session cookie updated');
  }

  async markAlive() { await this.#store.markAlive(); }
  async markChecked() { await this.#store.markChecked(); }

  async markDead(reason) {
    await this.#store.markDead();
    await this.#alert(
      `uc-session-dead-${this.instanceId}`,
      `Unicommerce ${this.instanceId} session is DEAD - automations for that instance are blocked`,
      { reason, instanceId: this.instanceId },
    );
  }

  async status() { return this.#store.status(); }

  /**
   * Called on real session death. Returns true if a fresh session was obtained
   * (caller retries once), false if dead in the water. Mutex'd: concurrent
   * failures share one refresh attempt.
   */
  async refresh(reason) {
    if (!this.#refreshing) {
      this.#refreshing = this.#doRefresh(reason).finally(() => { this.#refreshing = null; });
    }
    return this.#refreshing;
  }

  async #doRefresh(reason) {
    logger.warn({ instanceId: this.instanceId, reason }, 'uc session death detected - attempting refresh');
    // FIRST: did an admin paste a fresh cookie into the store since we last read it?
    // Adopt it and retry before falling back to scripted login / giving up. This is
    // what makes "paste in Admin → goes ALIVE" work across the API/worker split.
    const before = this.#cookie;
    await this.reload();
    if (this.#cookie && this.#cookie !== before) {
      logger.info({ instanceId: this.instanceId }, 'uc session adopted a freshly-pasted cookie');
      return true;
    }
    if (typeof this.loginScripted === 'function') {
      try {
        const fresh = await this.loginScripted();
        await this.setCookie(fresh, 'scripted-login', 'system');
        await this.markAlive();
        logger.info({ instanceId: this.instanceId }, 'uc session refreshed via scripted login');
        return true;
      } catch (err) {
        await this.markDead(`scripted login failed: ${err.message}`);
        return false;
      }
    }
    // No scripted login available yet (pre-whitelisted-account bridge).
    await this.markDead(reason);
    return false;
  }
}
