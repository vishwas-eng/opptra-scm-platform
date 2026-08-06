// Home Centre UC target split:
//   inventory → UAE UC (HC_UC_UAE_* / HC_UC_*)
//   orders    → STAGING by default (HC_ORDERS_UC_TARGET=staging); flip to uae when approved
//
// Each target gets its own session vault row (instance_id = staging|uae) so OAuth /
// future /data calls never overwrite the India bot JSESSIONID.
import { UcClient, PgSessionStore, normalizeInstanceId } from '@opptra/uc-client';

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

/**
 * Parse HC_SKU_MAP_JSON.
 *
 * A malformed map used to be swallowed into `{}`, which is indistinguishable from "no
 * map configured" — so a typo in the env silently degraded every order to the identity
 * mapping (or, on staging, to the `optest` fallback) and the sync still reported
 * success. A bad map is a configuration error and must be loud.
 */
export function parseSkuMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`HC_SKU_MAP_JSON is not valid JSON (${err.message}). Fix it or unset it — an unparseable map would silently map every SKU to itself.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HC_SKU_MAP_JSON must be a JSON object of {"hcSku":"ucSku"} pairs.');
  }
  return parsed;
}

/** Effective run mode for writes. Production Vinculum inventory + UAE SO require HC_LIVE. */
export function resolveHcMode(cfg, input = {}) {
  const live = truthy(cfg.HC_LIVE);
  const dryDefault = cfg.HC_DRY_RUN === undefined || cfg.HC_DRY_RUN === ''
    ? true
    : truthy(cfg.HC_DRY_RUN);
  const dryRun = input.dryRun !== undefined ? !!input.dryRun : dryDefault;
  const ordersTarget = String(cfg.HC_ORDERS_UC_TARGET || 'staging').toLowerCase() === 'uae'
    ? 'uae'
    : 'staging';

  // Staging SO create is allowed when dryRun=false even if HC_LIVE=false.
  const allowStagingSoWrite = !dryRun && ordersTarget === 'staging';
  // UAE/production SO create only when HC_LIVE + orders target uae + not dry-run.
  const allowUaeSoWrite = !dryRun && live && ordersTarget === 'uae';
  const allowOrderWrite = allowStagingSoWrite || allowUaeSoWrite;
  // Vinculum inventory upload is always a marketplace write — HC_LIVE only.
  const allowVinculumInventoryWrite = !dryRun && live;

  let modeLabel = 'dry-run';
  if (allowOrderWrite && ordersTarget === 'staging') modeLabel = 'staging-orders';
  if (allowUaeSoWrite) modeLabel = 'live-uae-orders';
  if (allowVinculumInventoryWrite) modeLabel = modeLabel === 'dry-run' ? 'live-inventory' : `${modeLabel}+live-inventory`;

  return {
    live,
    dryRun,
    ordersTarget,
    allowOrderWrite,
    allowVinculumInventoryWrite,
    modeLabel,
  };
}

function pick(cfg, keys, fallback = '') {
  for (const k of keys) {
    const v = cfg[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

export function stagingUcConfig(cfg) {
  // Staging = dedicated staging user/session (personal for tests). Never India bot.
  return {
    label: 'staging',
    baseUrl: pick(cfg, ['HC_UC_STAGING_BASE_URL', 'HC_UC_BASE_URL'], 'https://oppdoorstg.unicommerce.com'),
    user: pick(cfg, ['HC_UC_STAGING_USER'], ''),
    pass: pick(cfg, ['HC_UC_STAGING_PASS'], ''),
    facility: pick(cfg, ['HC_UC_STAGING_FACILITY', 'HC_UC_FACILITY'], 'oppdoorstg'),
    channel: pick(cfg, ['HC_UC_STAGING_CHANNEL', 'HC_UC_CHANNEL'], 'CUSTOM'),
    shipMethod: pick(cfg, ['HC_UC_STAGING_SHIP_METHOD', 'HC_UC_SHIP_METHOD'], 'STD'),
    currency: pick(cfg, ['HC_UC_STAGING_CURRENCY', 'HC_UC_CURRENCY'], 'INR'),
    customerCode: pick(cfg, ['HC_UC_STAGING_CUSTOMER', 'HC_CUSTOMER_CODE'], 'OPPB2B01'),
    configured: !!(
      pick(cfg, ['HC_UC_STAGING_USER'], '')
      && pick(cfg, ['HC_UC_STAGING_PASS'], '')
    ),
  };
}

export function uaeUcConfig(cfg) {
  // Dedicated UAE bot — never fall back to India UC_USER / sc.automations.
  // Inventory for OppDoor HC seller SKUs lives at facility `opptrauae` (not OPP_RFS_FZ_UAE).
  // Prefer HC_UC_UAE_INV_FACILITY for inventory sync; session may still use OPP_RFS_FZ_UAE.
  return {
    label: 'uae',
    baseUrl: pick(cfg, ['HC_UC_UAE_BASE_URL', 'HC_UC_BASE_URL'], 'https://opptrauae.unicommerce.com'),
    user: pick(cfg, ['HC_UC_UAE_USER', 'UC_UAE_USER'], ''),
    pass: pick(cfg, ['HC_UC_UAE_PASS', 'UC_UAE_PASS'], ''),
    facility: pick(cfg, ['HC_UC_UAE_FACILITY', 'HC_UC_FACILITY'], ''),
    // Stock for OppDoor HC seller SKUs is at `opptrauae`. Do NOT inherit session facility
    // OPP_RFS_FZ_UAE (inventorySnapshot returns empty there for Tower SKUs).
    invFacility: pick(cfg, ['HC_UC_UAE_INV_FACILITY'], 'opptrauae'),
    channel: pick(cfg, ['HC_UC_UAE_CHANNEL', 'HC_UC_CHANNEL'], 'Home Centre B2C'),
    shipMethod: pick(cfg, ['HC_UC_UAE_SHIP_METHOD', 'HC_UC_SHIP_METHOD'], 'STD'),
    currency: pick(cfg, ['HC_UC_UAE_CURRENCY', 'HC_UC_CURRENCY'], 'AED'),
    customerCode: pick(cfg, ['HC_UC_UAE_CUSTOMER', 'HC_CUSTOMER_CODE'], ''),
    configured: !!(
      pick(cfg, ['HC_UC_UAE_USER', 'UC_UAE_USER'], '')
      && pick(cfg, ['HC_UC_UAE_PASS', 'UC_UAE_PASS'], '')
    ),
  };
}

export function ksaUcConfig(cfg) {
  // Dedicated KSA bot — never India UC_USER.
  return {
    label: 'ksa',
    baseUrl: pick(cfg, ['HC_UC_KSA_BASE_URL'], 'https://opptraksa.unicommerce.com'),
    user: pick(cfg, ['HC_UC_KSA_USER', 'UC_KSA_USER'], ''),
    pass: pick(cfg, ['HC_UC_KSA_PASS', 'UC_KSA_PASS'], ''),
    facility: pick(cfg, ['HC_UC_KSA_FACILITY'], ''),
    channel: pick(cfg, ['HC_UC_KSA_CHANNEL'], ''),
    shipMethod: pick(cfg, ['HC_UC_KSA_SHIP_METHOD'], 'STD'),
    currency: pick(cfg, ['HC_UC_KSA_CURRENCY'], 'SAR'),
    customerCode: pick(cfg, ['HC_UC_KSA_CUSTOMER'], ''),
    configured: !!(
      pick(cfg, ['HC_UC_KSA_USER', 'UC_KSA_USER'], '')
      && pick(cfg, ['HC_UC_KSA_PASS', 'UC_KSA_PASS'], '')
    ),
  };
}

export function ordersUcConfig(cfg) {
  const mode = resolveHcMode(cfg);
  return mode.ordersTarget === 'uae' ? uaeUcConfig(cfg) : stagingUcConfig(cfg);
}

export function inventoryUcConfig(cfg) {
  return uaeUcConfig(cfg);
}

/** Build a dedicated UcClient for a HC target (does not touch the India bot singleton). */
export function makeHcUcClient(targetCfg, { rps = 4, burst = 8 } = {}) {
  if (!targetCfg?.baseUrl) throw new Error('HC UC baseUrl missing');
  // Session-only targets (cookie in vault) may omit user/pass; OAuth needs both.
  const instanceId = normalizeInstanceId(
    targetCfg.label === 'uae' ? 'uae' : targetCfg.label === 'ksa' ? 'ksa' : 'staging',
  );
  return new UcClient({
    baseUrl: targetCfg.baseUrl,
    user: targetCfg.user || '',
    pass: targetCfg.pass || '',
    defaultFacility: targetCfg.facility || '',
    rps,
    burst,
    instanceId,
    sessionStore: new PgSessionStore({ instanceId }),
  });
}
