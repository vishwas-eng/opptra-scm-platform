import { createRegistry, createConnectorShell, CONNECTOR_ERROR_CODES, connectorError } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = '6thstreet';
export const CONNECTOR_NAME = '6th Street';

/**
 * 6th Street connector, RE/session primary (seller portal + IBM OMS behind VPN).
 * PRIMARY: picklist + invoice + label → email (pipeline).
 * SECONDARY: UC → portal inventory push.
 * Selling price: invoice only (enforced in automation-6thstreet).
 */
export function createSixthStreetConnector({ cfg = {}, getSecret, httpFetch = fetch } = {}) {
  const registry = createRegistry();

  const portalUrl = (cfg.STREET6_PORTAL_URL || 'https://seller-portal.6thstreet.com/#/app').replace(/#.*$/, '');
  const portalApiBase = (cfg.STREET6_PORTAL_API_BASE
    || 'https://prod-seller-portal-backend.6thstreet.com/sellerportal/').replace(/\/?$/, '/');
  const omsUrl = cfg.STREET6_OMS_URL || 'https://apg-oms.prod.coc.ibmcloud.com/wsc/store/login.do';
  const omsHomeUrl = cfg.STREET6_OMS_HOME_URL
    || 'https://apg-oms.prod.coc.ibmcloud.com/wsc/ngstore/home.do?scFlag=Y';
  const hasVpnCreds = !!(cfg.STREET6_VPN_USER && cfg.STREET6_VPN_PASS && cfg.STREET6_VPN_HOST);
  const hasPortalCreds = !!(cfg.STREET6_PORTAL_USER && cfg.STREET6_PORTAL_PASS);
  const hasOmsCreds = !!(cfg.STREET6_OMS_USER && cfg.STREET6_OMS_PASS);

  async function probe(url, label) {
    try {
      const res = await httpFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: { 'user-agent': 'OpptraSCM/0.1 6thstreet-health' },
      });
      return { label, ok: res.status > 0 && res.status < 500, status: res.status };
    } catch (err) {
      return { label, ok: false, status: 0, error: String(err.message || err).slice(0, 120) };
    }
  }

  registry.register({
    id: 'health.ping',
    title: '6th Street health',
    mutates: false,
    backend: 're',
    awaitingHar: false,
    description: 'Env presence + optional HTTPS probes (no secrets returned)',
    inputSchema: { type: 'object', additionalProperties: false, properties: { probe: { type: 'boolean' } } },
    handler: async (params) => {
      const out = {
        ok: hasVpnCreds && (hasPortalCreds || hasOmsCreds),
        connector: CONNECTOR_ID,
        vpnConfigured: hasVpnCreds,
        portalConfigured: hasPortalCreds,
        omsConfigured: hasOmsCreds,
        emailTo: cfg.STREET6_EMAIL_TO || 'daniyal@opptra.com',
        ucInstance: cfg.STREET6_UC_INSTANCE || 'india',
        live: /^(1|true|yes|on)$/i.test(String(cfg.STREET6_LIVE ?? '').trim()),
        dryRunDefault: cfg.STREET6_DRY_RUN === undefined || cfg.STREET6_DRY_RUN === ''
          ? true
          : /^(1|true|yes|on)$/i.test(String(cfg.STREET6_DRY_RUN).trim()),
        awaitingHar: true,
        portalApiBase,
        portalApisKnown: [
          'api/public/login',
          'api/inventory/live',
          'api/inventory/upload',
          'api/price/live',
          'api/price/upload',
        ],
        omsLoginUrl: omsUrl,
        omsHomeUrl,
        artifactHints: {
          invoice: 'OMS IBM Store Engagement PDF; ORDER NUMBER; selling price = line Price (SAR)',
          label: 'Filename often SAC########.pdf; embeds order id + COD total',
          packEmailNames: '{orderId}_picklist.xlsx | {orderId}_invoice.pdf | {orderId}_label.pdf',
        },
        note: 'Seller-portal APIs reversed (inventory/price). Picklist/invoice/label = IBM OMS behind private VPN 10.61.1.11, need public Forti hostname or Path B HAR. See docs/connectors/6thstreet-API-REVERSE.md',
      };
      if (params?.probe) {
        out.probes = {
          portal: await probe(portalUrl.replace(/\/$/, '') + '/', 'seller-portal'),
          portalApi: await probe(portalApiBase + 'api/public/login', 'seller-portal-api'),
          omsLogin: await probe(omsUrl, 'ibm-oms-login'),
          omsHome: await probe(omsHomeUrl, 'ibm-oms-ngstore'),
        };
        // VPN private IP is not probeable from public internet; only note.
        out.probes.vpnHostNote = 'Private IP 10.61.1.11 requires FortiClient / public SSL VPN host; not probed from public network.';
      }
      const sec = getSecret ? await getSecret() : null;
      out.hasSessionVault = !!sec?.secret;
      return out;
    },
  });

  for (const [id, title, desc] of [
    ['picklist.download', 'Download pick list', 'Excel pick list from portal/OMS, HAR required'],
    ['invoice.download', 'Download invoice', 'Invoice PDF (selling price source), HAR required'],
    ['label.download', 'Download shipping label', 'Label PDF at pack, HAR required'],
  ]) {
    registry.register({
      id,
      title,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: desc,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderId: { type: 'string', maxLength: 80 },
          dryRun: { type: 'boolean' },
        },
      },
      handler: async () => connectorError(
        CONNECTOR_ERROR_CODES.AWAITING_HAR,
        `6th Street ${id} awaiting sanitized HAR after VPN login. See docs/connectors/6thstreet.md`,
        { awaitingHar: true },
      ),
    });
  }

  registry.register({
    id: 'pack.email',
    title: 'Email pick list + invoice + label',
    mutates: true,
    backend: 're',
    awaitingHar: true,
    description: 'Assemble picklist, invoice, label → Gmail to STREET6_EMAIL_TO (invoice price only)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orderIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        dryRun: { type: 'boolean' },
        send: { type: 'boolean', description: 'If true and LIVE, send; else draft' },
      },
    },
    handler: async () => connectorError(
      CONNECTOR_ERROR_CODES.AWAITING_HAR,
      'pack.email needs picklist/invoice/label download HARs. Pipeline scaffold is in @opptra/automation-6thstreet.',
      { awaitingHar: true },
    ),
  });

  registry.register({
    id: 'inventory.push',
    title: 'Push UC inventory to 6th Street',
    mutates: true,
    backend: 're',
    awaitingHar: true,
    description: 'UC snapshot (STREET6_UC_INSTANCE) → seller portal inventory update',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skus: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        dryRun: { type: 'boolean' },
      },
    },
    handler: async () => connectorError(
      CONNECTOR_ERROR_CODES.AWAITING_HAR,
      'inventory.push awaiting portal upload/update HAR. UC read path is ready once facility confirmed.',
      { awaitingHar: true },
    ),
  });

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: { kind: 'session', primary: 'session', officialFutureSwap: false },
    registry,
    health: async () => {
      const r = await registry.getAction('health.ping').handler({ probe: false }, {});
      return { ok: !!r.ok, connector: CONNECTOR_ID, detail: r };
    },
  });
}

export default { createSixthStreetConnector, CONNECTOR_ID, CONNECTOR_NAME };

export { makeStreet6PortalClient } from './portalClient.js';
