import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'myntra';
export const CONNECTOR_NAME = 'Myntra Partner';

/**
 * Myntra Partner/Seller, RE/session primary.
 * Opptra already emits Myntra ASN XLSX via automation-asn; portal write-back needs HAR.
 */
export function createMyntraConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Myntra session health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Partner portal session probe, needs cookie vault + HAR for ping URL',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: 'Connect Myntra: paste Partner portal session cookie. See docs/connectors/myntra.md' };
      }
      return {
        ok: false,
        awaitingHar: true,
        hasSession: true,
        note: 'ASN compile already works via Unicommerce→Myntra XLSX. Portal orders/PO XHR needs HAR.',
      };
    },
  });

  registry.register({
    id: 'orders.search',
    title: 'List PO / orders',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Partner portal PO list XHR (HAR required)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => ({ ok: false, awaitingHar: true, error: 'Myntra orders.search awaiting sanitized HAR.' }),
  });

  registry.register({
    id: 'asn.status',
    title: 'ASN acceptance status',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Check ASN acceptance on Partner portal (HAR). Local ASN files: use ASN Compile tab.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { po: { type: 'string' } } },
    handler: async () => ({ ok: false, awaitingHar: true, error: 'Myntra asn.status awaiting HAR. Use ASN Compile for file generation.' }),
  });

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

export default { createMyntraConnector, CONNECTOR_ID, CONNECTOR_NAME };
