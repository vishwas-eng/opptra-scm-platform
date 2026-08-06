import { config } from '@opptra/core';
import { UcClient } from './client.js';
import { PgSessionStore } from './store.js';
import {
  UC_INSTANCE_IDS,
  normalizeInstanceId,
  resolveInstanceBaseUrl,
  instanceIdFromHost,
} from './instances.js';

// Public API of this package - only what other packages actually consume: the shared
// client singleton and the two error types callers branch on. Tests reach internals
// (UcClient, RateLimiter, makeHttp, …) via deep paths on purpose; those are not API.
export { SessionError, ConfigError } from './errors.js';
export { UcClient } from './client.js';
export { makeUcOrderLookup, soVariants, prettyChannel } from './order.js';
export { PgSessionStore, MemorySessionStore } from './store.js';
export {
  UC_INSTANCE_IDS,
  normalizeInstanceId,
  resolveInstanceBaseUrl,
  instanceIdFromHost,
} from './instances.js';

const clients = new Map();

/**
 * Process-wide client for a UC instance.
 * Default `india` preserves packing / sheet / e-way.
 *
 * Account policy (2026-08):
 *   india   → UC_USER only (sc.automations@opptra.com)
 *   uae     → HC_UC_UAE_USER / UC_UAE_USER only (scuae.automations@opptra.com) — never India bot
 *   ksa     → HC_UC_KSA_USER / UC_KSA_USER only (scksa.automations@opptra.com) — never India bot
 *   DL emails need a real UC user password or Admin JSESSIONID paste — see docs/UC-SESSIONS.md
 *   staging → HC_UC_STAGING_USER only (personal / staging bot for tests) — never India bot
 */
export function ucClient(instanceId = 'india') {
  const id = normalizeInstanceId(instanceId);
  if (!clients.has(id)) {
    const c = config();
    const baseUrl = resolveInstanceBaseUrl(id, c);
    let user = '';
    let pass = '';
    let facility = '';
    if (id === 'india') {
      user = c.UC_USER || '';
      pass = c.UC_PASS || '';
      facility = c.UC_DEFAULT_FACILITY || '';
    } else if (id === 'uae') {
      user = c.HC_UC_UAE_USER || c.UC_UAE_USER || '';
      pass = c.HC_UC_UAE_PASS || c.UC_UAE_PASS || '';
      facility = c.HC_UC_UAE_FACILITY || '';
    } else if (id === 'ksa') {
      user = c.HC_UC_KSA_USER || c.UC_KSA_USER || '';
      pass = c.HC_UC_KSA_PASS || c.UC_KSA_PASS || '';
      facility = c.HC_UC_KSA_FACILITY || '';
    } else {
      // staging
      user = c.HC_UC_STAGING_USER || '';
      pass = c.HC_UC_STAGING_PASS || '';
      facility = c.HC_UC_STAGING_FACILITY || 'oppdoorstg';
    }
    clients.set(id, new UcClient({
      baseUrl,
      user,
      pass,
      overrideCookie: id === 'india' ? c.UC_JSESSIONID_OVERRIDE : '',
      defaultFacility: facility,
      rps: c.UC_MAX_RPS,
      burst: c.UC_BURST,
      instanceId: id,
      sessionStore: new PgSessionStore({ instanceId: id }),
    }));
  }
  return clients.get(id);
}

/** @deprecated Prefer ucClient('india') — kept as the historical singleton entry. */
export function indiaUcClient() {
  return ucClient('india');
}

export { UC_INSTANCE_IDS as knownUcInstances };
