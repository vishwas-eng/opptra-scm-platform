// Known Unicommerce tenants and how they map onto the session vault.
//
//   india, oppdoor.unicommerce.co.in   (packing / sheet / e-way / India bot)
//   uae, opptrauae.unicommerce.com   (HC inventory; future HC orders)
//   ksa, opptraksa.unicommerce.com   (KSA tenant; 6th Street / future)
//   staging, oppdoorstg.unicommerce.com  (HC orders proof)
//
// Session cookies (JSESSIONID) are stored per instance_id and must never cross.
// Company codes from UC "Choose your company": oppdoor, oppdoorstg, opptrauae, opptraksa.

export const UC_INSTANCE_IDS = Object.freeze(['india', 'uae', 'ksa', 'staging']);

const DEFAULT_BASE = Object.freeze({
  india: 'https://oppdoor.unicommerce.co.in',
  uae: 'https://opptrauae.unicommerce.com',
  ksa: 'https://opptraksa.unicommerce.com',
  staging: 'https://oppdoorstg.unicommerce.com',
});

/** Normalize + validate an instance id. Unknown → throws. */
export function normalizeInstanceId(raw, { fallback = 'india' } = {}) {
  const id = String(raw ?? fallback).trim().toLowerCase();
  if (!UC_INSTANCE_IDS.includes(id)) {
    throw new Error(`Unknown UC instance "${raw}". Expected one of: ${UC_INSTANCE_IDS.join(', ')}`);
  }
  return id;
}

/**
 * Resolve base URL for an instance from config (env).
 * Prefers explicit HC_UC_* / UC_BASE_URL, else hard defaults.
 */
export function resolveInstanceBaseUrl(instanceId, cfg = {}) {
  const id = normalizeInstanceId(instanceId);
  if (id === 'india') {
    return String(cfg.UC_BASE_URL || DEFAULT_BASE.india).replace(/\/+$/, '');
  }
  if (id === 'uae') {
    return String(
      cfg.HC_UC_UAE_BASE_URL || cfg.HC_UC_BASE_URL || DEFAULT_BASE.uae,
    ).replace(/\/+$/, '');
  }
  if (id === 'ksa') {
    return String(
      cfg.HC_UC_KSA_BASE_URL || cfg.STREET6_UC_BASE_URL || DEFAULT_BASE.ksa,
    ).replace(/\/+$/, '');
  }
  return String(
    cfg.HC_UC_STAGING_BASE_URL || cfg.HC_UC_BASE_URL || DEFAULT_BASE.staging,
  ).replace(/\/+$/, '');
}

/** Host → instance id (for ingest helpers that only know the portal URL). */
export function instanceIdFromHost(hostOrUrl) {
  const raw = String(hostOrUrl || '').trim().toLowerCase();
  let host = raw;
  try {
    if (raw.includes('://')) host = new URL(raw).hostname;
  } catch { /* use raw */ }
  host = host.replace(/^www\./, '');
  if (host.includes('oppdoorstg') || host.includes('staging')) return 'staging';
  if (host.includes('opptraksa') || host.includes('ksa')) return 'ksa';
  // Correct host is opptrauae; keep oppdooruae as legacy alias for old pastes/docs.
  if (host.includes('opptrauae') || host.includes('oppdooruae') || host.includes('uae')) return 'uae';
  if (host.includes('oppdoor') || host.includes('unicommerce.co.in')) return 'india';
  return null;
}
