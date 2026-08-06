import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'meesho';
export const CONNECTOR_NAME = 'Meesho Supplier';

/** RE scaffold — Referenced in agent plan; supplier portal RE. Live XHR actions unlock after sanitized HAR. */
export function createMeeshoConnector({ getSecret } = {}) {
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: 'Meesho Supplier health',
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: 'Session vault probe — ping URL pending HAR (supplier.meesho.com)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: 'Connect Meesho Supplier: paste portal session cookie. See docs/connectors/meesho.md' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map XHR via HAR (docs/connectors/meesho.md).' };
    },
  });

  for (const action of ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `Meesho Supplier ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: 'Meesho Supplier ' + action + ' awaiting sanitized HAR.' }),
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

export default { createMeeshoConnector, CONNECTOR_ID, CONNECTOR_NAME };
