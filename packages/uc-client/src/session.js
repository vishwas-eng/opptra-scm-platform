// SessionManager — the single owner of the Unicommerce JSESSIONID.
//
// Design contract (do not weaken):
//  1. ONE process talks to UC with this session (the worker). The cookie lives in
//     Postgres (uc_session singleton row) so it survives restarts and can be updated
//     from the Admin tab.
//  2. Session death = HTTP 401 / login redirect / USER_NOT_LOGGED_IN only.
//     `successful:false` bodies are business responses, not death.
//  3. On death: refresh behind a mutex. Strategies, in order:
//        a. 'scripted-login'  — whitelisted-account login (enabled once the login
//                               HAR is captured; see loginScripted()).
//        b. give up loudly    — mark dead + alert; Admin tab shows a red banner and
//                               accepts a pasted cookie as the manual bridge.
//  4. Keep-alive (worker cron) pings a cheap endpoint every UC_KEEPALIVE_MINUTES.
import { logger, alert as defaultAlert } from '@opptra/core';
import { SessionError } from './errors.js';
import { PgSessionStore } from './store.js';

export class SessionManager {
  #store; #alert;
  #cookie = '';
  #loaded = false;
  #refreshing = null;
  /** Optional scripted-login implementation, injected when available. */
  loginScripted = null;

  constructor({ overrideCookie = '', store = null, alertFn = null } = {}) {
    this._override = (overrideCookie || '').trim().replace(/^JSESSIONID=/i, '');
    this.#store = store || new PgSessionStore();
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
    logger.info({ hasCookie: !!this.#cookie, source: row.source }, 'uc session loaded');
  }

  async getCookie() {
    if (!this.#loaded) await this.load();
    // If we have no cookie in memory, the store may have gained one (admin pasted it in
    // the API process). Re-read before giving up so a first paste works immediately.
    if (!this.#cookie) await this.reload();
    if (!this.#cookie) {
      throw new SessionError('no UC session available — paste one in Admin or configure scripted login');
    }
    return this.#cookie;
  }

  /** Re-read the cookie from the store. The admin paste happens in the API process, so
   *  the worker's SessionManager must reload to see it. Returns true if it changed. */
  async reload() {
    const row = await this.#store.get();
    const cookie = row.jsessionid || '';
    this.#loaded = true;
    if (cookie === this.#cookie) return false;
    this.#cookie = cookie;
    logger.info({ source: row.source, hasCookie: !!cookie }, 'uc session cookie reloaded from store');
    return true;
  }

  /** Store a new cookie (admin paste, env override, or scripted login result). */
  async setCookie(raw, source, actor) {
    const cookie = String(raw || '').trim().replace(/^JSESSIONID=/i, '');
    if (!cookie) throw new SessionError('empty session cookie');
    this.#cookie = cookie;
    this.#loaded = true;
    await this.#store.set(cookie, source, actor);
    logger.info({ source, actor }, 'uc session cookie updated');
  }

  async markAlive() { await this.#store.markAlive(); }
  async markChecked() { await this.#store.markChecked(); }

  async markDead(reason) {
    await this.#store.markDead();
    await this.#alert('uc-session-dead', 'Unicommerce session is DEAD — automations are blocked', { reason });
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
    logger.warn({ reason }, 'uc session death detected — attempting refresh');
    // FIRST: did an admin paste a fresh cookie into the store since we last read it?
    // Adopt it and retry before falling back to scripted login / giving up. This is
    // what makes "paste in Admin → goes ALIVE" work across the API/worker split.
    const before = this.#cookie;
    await this.reload();
    if (this.#cookie && this.#cookie !== before) {
      logger.info('uc session adopted a freshly-pasted cookie');
      return true;
    }
    if (typeof this.loginScripted === 'function') {
      try {
        const fresh = await this.loginScripted();
        await this.setCookie(fresh, 'scripted-login', 'system');
        await this.markAlive();
        logger.info('uc session refreshed via scripted login');
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
