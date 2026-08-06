import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'nykaa';
export const CONNECTOR_NAME = 'Nykaa Seller';

/** RE scaffold — Nykaa Fashion/Beauty seller portal. Live XHR actions unlock after sanitized HAR. */
export function createNykaaConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Nykaa Seller health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Session vault probe — ping URL pending HAR (seller.nykaa.com)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: 'Connect Nykaa Seller: paste portal session cookie. See docs/connectors/nykaa.md' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map XHR via HAR (docs/connectors/nykaa.md).' };
    },
  });

  for (const action of ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `Nykaa Seller ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: 'Nykaa Seller ' + action + ' awaiting sanitized HAR.' }),
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

export default { createNykaaConnector, CONNECTOR_ID, CONNECTOR_NAME };
