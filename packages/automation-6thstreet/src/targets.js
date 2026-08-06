/**
 * Map STREET6_UC_INSTANCE → UC credentials.
 * india → UC_USER only; uae/ksa → dedicated bots; never cross-fall back to India for GCC.
 */
export function resolveStreet6UcTarget(cfg = {}, requested = '') {
  // The region the operator picked wins over the env default. Without this, choosing
  // KSA in the UI still read India stock and pushed it to a KSA storefront, which is
  // worse than failing.
  const instance = String(requested || cfg.STREET6_UC_INSTANCE || 'india').toLowerCase();
  if (instance === 'uae') {
    return {
      label: 'uae',
      baseUrl: cfg.HC_UC_UAE_BASE_URL || cfg.STREET6_UC_BASE_URL || 'https://opptrauae.unicommerce.com',
      user: cfg.STREET6_UC_USER || cfg.HC_UC_UAE_USER || cfg.UC_UAE_USER || '',
      pass: cfg.STREET6_UC_PASS || cfg.HC_UC_UAE_PASS || cfg.UC_UAE_PASS || '',
      facility: cfg.STREET6_UC_FACILITY || cfg.HC_UC_UAE_FACILITY || '',
      configured: !!(cfg.STREET6_UC_USER || cfg.HC_UC_UAE_USER || cfg.UC_UAE_USER),
    };
  }
  if (instance === 'ksa') {
    return {
      label: 'ksa',
      baseUrl: cfg.HC_UC_KSA_BASE_URL || cfg.STREET6_UC_BASE_URL || 'https://opptraksa.unicommerce.com',
      user: cfg.STREET6_UC_USER || cfg.HC_UC_KSA_USER || cfg.UC_KSA_USER || '',
      pass: cfg.STREET6_UC_PASS || cfg.HC_UC_KSA_PASS || cfg.UC_KSA_PASS || '',
      facility: cfg.STREET6_UC_FACILITY || cfg.HC_UC_KSA_FACILITY || '',
      configured: !!(cfg.STREET6_UC_USER || cfg.HC_UC_KSA_USER || cfg.UC_KSA_USER),
    };
  }
  if (instance === 'staging') {
    return {
      label: 'staging',
      baseUrl: cfg.HC_UC_STAGING_BASE_URL || 'https://oppdoorstg.unicommerce.com',
      user: cfg.STREET6_UC_USER || cfg.HC_UC_STAGING_USER || '',
      pass: cfg.STREET6_UC_PASS || cfg.HC_UC_STAGING_PASS || '',
      facility: cfg.STREET6_UC_FACILITY || cfg.HC_UC_STAGING_FACILITY || 'oppdoorstg',
      configured: !!(cfg.STREET6_UC_USER || cfg.HC_UC_STAGING_USER),
    };
  }
  // india (default until env flipped), sc.automations only.
  // Evidence 2026-08-04: invoice SKU 5056791600146 exists on KSA (OPP_SLS_ML_KSA), not as a HC LAND* code.
  // Prefer STREET6_UC_INSTANCE=ksa + HC_UC_KSA_* / UC_KSA_* once ops confirms 6th Street stocks from KSA.
  return {
    label: 'india',
    baseUrl: cfg.STREET6_UC_BASE_URL || cfg.UC_BASE_URL || '',
    user: cfg.STREET6_UC_USER || cfg.UC_USER || '',
    pass: cfg.STREET6_UC_PASS || cfg.UC_PASS || '',
    facility: cfg.STREET6_UC_FACILITY || '',
    configured: !!(cfg.UC_BASE_URL && (cfg.STREET6_UC_USER || cfg.UC_USER)),
    note: 'Default india for safety. Recommend STREET6_UC_INSTANCE=ksa (sample EAN SKU lives on opptraksa / OPP_SLS_ML_KSA).',
  };
}
