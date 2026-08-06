// Factory for not-yet-cracked channel connectors. A stub earns its place by making the
// roadmap visible (Connectors page) and by holding a pasted session in the vault so the
// reverse-engineering pass starts from a live cookie — every action stays behind
// awaitingHar until a sanitized HAR proves the real endpoints.
//
// This replaces five copy-pasted 52-line packages that differed only in id/name/blurb.
import { createRegistry } from './index.js';
import { createConnectorShell } from './index.js';

/**
 * @param {{
 *   id: string,                 // connector id, e.g. 'nykaa'
 *   name: string,               // display name, e.g. 'Nykaa Seller'
 *   portalHint: string,         // where the session comes from, e.g. 'seller.nykaa.com'
 *   docSlug?: string,           // docs/connectors/<slug>.md (defaults to id)
 *   actions?: string[],         // planned read actions beyond health.ping
 *   getSecret?: () => Promise<{ secret?: string } | null>,
 * }} def
 */
export function createStubConnector({ id, name, portalHint, docSlug, actions, getSecret } = {}) {
  if (!id || !name) throw new Error('createStubConnector requires id and name');
  const doc = `docs/connectors/${docSlug || id}.md`;
  const registry = createRegistry();

  registry.register({
    id: 'health.ping',
    title: `${name} health`,
    mutates: false,
    backend: 're',
    awaitingHar: true,
    description: `Session vault probe — ping URL pending HAR (${portalHint})`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: `Connect ${name}: paste portal session cookie. See ${doc}` };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: `Session stored; map XHR via HAR (${doc}).` };
    },
  });

  for (const action of actions || ['orders.search', 'inventory.get']) {
    registry.register({
      id: action,
      title: action,
      mutates: false,
      backend: 're',
      awaitingHar: true,
      description: `${name} ${action} — HAR required`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => ({ ok: false, awaitingHar: true, error: `${name} ${action} awaiting sanitized HAR.` }),
    });
  }

  return createConnectorShell({
    id,
    name,
    auth: { kind: 'session', primary: 'session', officialFutureSwap: true },
    registry,
    health: async () => {
      const r = await registry.getAction('health.ping').handler({}, {});
      return { ok: !!r.ok, connector: id, detail: r };
    },
  });
}
