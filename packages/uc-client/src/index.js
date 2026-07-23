import { config } from '@opptra/core';
import { UcClient } from './client.js';

// Public API of this package - only what other packages actually consume: the shared
// client singleton and the two error types callers branch on. Tests reach internals
// (UcClient, RateLimiter, makeHttp, …) via deep paths on purpose; those are not API.
export { SessionError, ConfigError } from './errors.js';

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
      rps: c.UC_MAX_RPS,
      burst: c.UC_BURST,
    });
  }
  return singleton;
}
