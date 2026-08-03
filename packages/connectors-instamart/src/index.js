import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'instamart';
export const CONNECTOR_NAME = 'Swiggy Instamart';

/** RE scaffold — Same class as Zepto/Blinkit. Live XHR actions unlock after sanitized HAR. */
export function createInstamartConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Swiggy Instamart health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Session vault probe — ping URL pending HAR (Swiggy partner portal)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret_enc) {
        return { ok: false, awaitingHar: true, error: 'Connect Swiggy Instamart: paste portal session cookie. See docs/connectors/instamart.md' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map XHR via HAR (docs/connectors/instamart.md).' };
    },
  });

  for (const action of ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `Swiggy Instamart ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: 'Swiggy Instamart ' + action + ' awaiting sanitized HAR.' }),
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

export default { createInstamartConnector, CONNECTOR_ID, CONNECTOR_NAME };
