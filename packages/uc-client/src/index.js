import { config } from '@opptra/core';
import { UcClient } from './client.js';

export { UcClient } from './client.js';
export { SessionManager } from './session.js';
export { BearerManager } from './bearer.js';
export { UcError, SessionError, ConfigError } from './errors.js';
export { Mutex, makeHttp } from './http.js';

let singleton = null;

/** Process-wide client (the worker uses this; tests construct UcClient directly). */
export function ucClient() {
  if (!singleton) {
    const c = config();
    singleton = new UcClient({
      baseUrl: c.UC_BASE_URL,
      user: c.UC_USER,
      pass: c.UC_PASS,
      overrideCookie: c.UC_JSESSIONID_OVERRIDE,
      defaultFacility: c.UC_DEFAULT_FACILITY,
    });
  }
  return singleton;
}
