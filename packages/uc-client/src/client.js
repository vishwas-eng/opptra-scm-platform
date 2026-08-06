// UcClient - the ONLY way platform code talks to Unicommerce.
//
//  - public(path, body, {facility})   → bearer + Facility header (stateless, concurrent-safe)
//  - data(path, body, {facility})     → JSESSIONID cookie; facility-scoped, so ALL internal
//                                       calls are serialized behind one mutex and the client
//                                       switches facility before the call when needed.
//  - dataGet / dataBinary             → same session rules, GET / binary (PDF) flavours.
//    (dataBinary is the download primitive for the upcoming reverse-DC / invoice-PDF
//     automations; kept here because those live on the same session/facility rules.)
//
// Death handling: a SessionError triggers ONE mutex'd refresh + ONE retry, then throws.
import { logger } from '@opptra/core';
import { makeHttp, Mutex } from './http.js';
import { RateLimiter } from './ratelimit.js';
import { BearerManager } from './bearer.js';
import { SessionManager } from './session.js';
import { UcError, SessionError } from './errors.js';

const DEATH_STATUS = new Set([301, 302, 401]);

export class UcClient {
  #http; #mutex = new Mutex();
  #currentFacility = null;

  constructor({
    baseUrl, user, pass, overrideCookie = '', defaultFacility = '',
    fetchImpl, sessionStore, alertFn, rps, burst, instanceId = 'india',
  } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.defaultFacility = defaultFacility;
    this.instanceId = instanceId;
    // One shared limiter throttles ALL public + internal calls across every automation.
    this.limiter = new RateLimiter({ rps: rps ?? 4, burst: burst ?? 8 });
    this.#http = makeHttp({ fetchImpl, limiter: this.limiter });
    this.bearer = new BearerManager({ http: this.#http, baseUrl: this.base, user, pass });
    // Env JSESSIONID override is India-only — never seed UAE/staging from UC_JSESSIONID_OVERRIDE.
    const cookieOverride = instanceId === 'india' ? overrideCookie : '';
    this.session = new SessionManager({
      overrideCookie: cookieOverride,
      store: sessionStore,
      alertFn,
      instanceId,
    });
  }

  /* ---------------- public API (bearer) ---------------- */
  async public(path, body = {}, { facility = this.defaultFacility, idempotent = false } = {}) {
    const call = async () => {
      const res = await this.#http.request(this.base + path, {
        method: 'POST',
        headers: {
          Authorization: 'bearer ' + (await this.bearer.get()),
          'Content-Type': 'application/json',
          ...(facility ? { Facility: facility } : {}),
        },
        body: JSON.stringify(body),
        idempotent,
      });
      if (res.status === 401) { this.bearer.invalidate(); throw new UcError(path, 401, 'bearer rejected'); }
      const data = await res.json().catch(() => null);
      if (!data) throw new UcError(path, res.status, 'non-JSON response');
      if (data.successful === false) {
        const msg = (data.errors || []).map((e) => e.description || e.message).join('; ') || 'successful:false';
        throw new UcError(path, res.status, msg);
      }
      return data;
    };
    try {
      return await call();
    } catch (err) {
      // One retry after bearer invalidation (fresh token).
      if (err instanceof UcError && err.http === 401) return call();
      throw err;
    }
  }

  /* ---------------- internal /data (session) ---------------- */

  async data(path, body = {}, opts = {}) {
    return this.#internal(() => this.#dataOnce('POST', path, JSON.stringify(body), opts), path, opts);
  }

  async dataGet(path, opts = {}) {
    return this.#internal(() => this.#dataOnce('GET', path, undefined, { ...opts, idempotent: true }), path, opts);
  }

  /** Binary download (invoice/CN PDFs, export CSVs). Returns { buffer, contentType }. */
  async dataBinary(path, opts = {}) {
    return this.#internal(async () => {
      const res = await this.#rawRequest('GET', path, undefined, { ...opts, idempotent: true });
      this.#throwIfDead(res, path);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: res.headers.get('content-type') || 'application/octet-stream' };
    }, path, opts);
  }

  /** Serialize + facility-switch + retry-once-on-session-death wrapper. */
  async #internal(fn, path, { facility = null } = {}) {
    return this.#mutex.run(async () => {
      const run = async () => {
        if (facility && facility !== this.#currentFacility) await this.#switchFacility(facility);
        return fn();
      };
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof SessionError)) throw err;
        const refreshed = await this.session.refresh(`${path}: ${err.message}`);
        if (!refreshed) throw err;
        this.#currentFacility = null; // fresh session → unknown facility context
        return run();
      }
    });
  }

  async #dataOnce(method, path, body, { idempotent = false, timeoutMs } = {}) {
    const res = await this.#rawRequest(method, path, body, { idempotent, timeoutMs });
    this.#throwIfDead(res, path);
    const data = await res.json().catch(() => null);
    if (!data) throw new UcError(path, res.status, 'non-JSON response');
    const errs = Array.isArray(data?.errors) ? data.errors : [];
    if (errs.some((e) => /USER_NOT_LOGGED_IN/i.test(String(e?.code || e?.message || '')))) {
      throw new SessionError('USER_NOT_LOGGED_IN');
    }
    return data; // envelopes vary; callers inspect .successful - soft-false is NOT death
  }

  async #rawRequest(method, path, body, { idempotent = false, timeoutMs } = {}) {
    const cookie = await this.session.getCookie();
    return this.#http.request(this.base + path, {
      method,
      headers: {
        Cookie: 'JSESSIONID=' + cookie,
        Accept: 'application/json, text/plain, */*',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      idempotent,
      timeoutMs,
    });
  }

  #throwIfDead(res, path) {
    if (DEATH_STATUS.has(res.status)) throw new SessionError(`session expired (HTTP ${res.status} on ${path})`);
    // NOTE: 403 is deliberately NOT death - wrong-facility responses can 403 (the @53 lesson).
  }

  async #switchFacility(code) {
    const d = await this.#dataOnce('POST', '/data/user/switchfacility',
      JSON.stringify({ currentUrl: '/b2b/orders', facilityCode: code }), {});
    if (d?.successful === false) {
      logger.warn({ facility: code }, 'switchfacility returned successful:false');
    }
    this.#currentFacility = code;
  }

  /** The account's real facility list, fetched live - never a hardcoded guess. Facility
   *  naming conventions vary and change (e.g. new fulfillment centers), so any pipeline
   *  that hops facilities should call this instead of maintaining its own static array. */
  async listFacilities() {
    const d = await this.dataGet('/data/user/facilities');
    const all = (d?.facilityDTOList || []).map((f) => f.code).filter(Boolean);
    return { all, current: d?.currentFacilityCode || null };
  }

  /* ---------------- health ---------------- */
  /** Cheap probe used by keep-alive; also verifies + records session liveness. */
  async ping() {
    try {
      // Pick up an admin-pasted cookie proactively (the paste lands in the DB from the
      // API process; the worker's session only sees it after a reload).
      await this.session.reload();
      const d = await this.dataGet('/data/user/facilities');
      await this.session.markAlive();
      return { alive: true, currentFacility: d?.currentFacilityCode || null };
    } catch (err) {
      await this.session.markChecked();
      if (err instanceof SessionError) return { alive: false, reason: err.message };
      throw err; // network/other errors bubble - they are not "session dead"
    }
  }
}
