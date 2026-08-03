import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'blinkit';
export const CONNECTOR_NAME = 'Blinkit Seller';

/** RE scaffold — Quick-commerce; packing mail already uses Blinkit marketplace label. Live XHR actions unlock after sanitized HAR. */
export function createBlinkitConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Blinkit Seller health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Session vault probe — ping URL pending HAR (seller.blinkit.in)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret_enc) {
        return { ok: false, awaitingHar: true, error: 'Connect Blinkit Seller: paste portal session cookie. See docs/connectors/blinkit.md' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map XHR via HAR (docs/connectors/blinkit.md).' };
    },
  });

  for (const action of ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `Blinkit Seller ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: 'Blinkit Seller ' + action + ' awaiting sanitized HAR.' }),
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

export default { createBlinkitConnector, CONNECTOR_ID, CONNECTOR_NAME };
