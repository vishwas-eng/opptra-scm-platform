// OAuth bearer for the PUBLIC API (/services/rest/v1). Proven flow:
//   GET /oauth/token?grant_type=password&client_id=my-trusted-client&username=..&password=..
// Tokens last ~12h; we refresh 5 minutes early behind a mutex so concurrent callers
// never stampede the token endpoint.
import { logger } from '@opptra/core';
import { ConfigError, UcError } from './errors.js';

export class BearerManager {
  #http; #base; #user; #pass;
  #token = null;
  #expiresAt = 0;
  #inflight = null;

  constructor({ http, baseUrl, user, pass }) {
    this.#http = http;
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#user = user;
    this.#pass = pass;
  }

  async get() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    if (!this.#inflight) {
      this.#inflight = this.#login().finally(() => { this.#inflight = null; });
    }
    return this.#inflight;
  }

  invalidate() { this.#token = null; this.#expiresAt = 0; }

  async #login() {
    if (!this.#user || !this.#pass) {
      throw new ConfigError('UC_USER / UC_PASS not set. Public-API calls unavailable.');
    }
    const q = new URLSearchParams({
      grant_type: 'password',
      client_id: 'my-trusted-client',
      username: this.#user,
      password: this.#pass,
    });
    const res = await this.#http.request(`${this.#base}/oauth/token?${q}`, { method: 'GET', idempotent: true });
    const body = await res.json().catch(() => null);
    if (!body || !body.access_token) {
      throw new UcError('/oauth/token', res.status, `OAuth failed: ${JSON.stringify(body).slice(0, 200)}`);
    }
    this.#token = body.access_token;
    this.#expiresAt = Date.now() + (Number(body.expires_in || 3600) - 300) * 1000;
    logger.info({ expiresInS: body.expires_in }, 'uc bearer token refreshed');
    return this.#token;
  }
}
