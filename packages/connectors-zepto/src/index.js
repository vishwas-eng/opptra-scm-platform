import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'zepto';
export const CONNECTOR_NAME = 'Zepto Vendor';

/** RE scaffold — ASN CSV already via UC automation-asn; portal write-back next. Live XHR actions unlock after sanitized HAR. */
export function createZeptoConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Zepto Vendor health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Session vault probe — ping URL pending HAR (vendor portal / Zepto)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: 'Connect Zepto Vendor: paste portal session cookie. See docs/connectors/zepto.md' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map XHR via HAR (docs/connectors/zepto.md).' };
    },
  });

  for (const action of ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `Zepto Vendor ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: 'Zepto Vendor ' + action + ' awaiting sanitized HAR.' }),
    });
  }

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: { kind: 'session', primary: 'session', officialFutureSwap: true },
    registry,
    health: async () => {
      const r = await registry.getAction('health.ping').handler({}, {});
      return { ok: !!r.ok, connector: CONNECTOR_ID, detail: r };
    },
  });
}

export default { createZeptoConnector, CONNECTOR_ID, CONNECTOR_NAME };
