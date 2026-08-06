// @opptra/connectors-stubs — every not-yet-cracked seller channel, one definition each.
// When a channel gets real endpoints (HAR decoded / official API creds), it graduates to
// its own package (like connectors-amazon) and its row here is deleted.
import { createStubConnector } from '@opptra/connectors-sdk';

/**
 * Channel definitions. `portalHint` is the seller portal whose session unlocks the
 * reverse-engineering pass; UAE/KSA channels note both storefronts.
 */
export const STUB_CHANNELS = Object.freeze([
  { id: 'nykaa', name: 'Nykaa Seller', portalHint: 'seller.nykaa.com' },
  { id: 'zepto', name: 'Zepto Vendor', portalHint: 'brands.zepto.co.in' },
  { id: 'blinkit', name: 'Blinkit Seller', portalHint: 'sellerhub.blinkit.com' },
  { id: 'instamart', name: 'Swiggy Instamart', portalHint: 'partner.swiggy.com' },
  { id: 'meesho', name: 'Meesho Supplier', portalHint: 'supplier.meesho.com' },
  { id: 'ajio', name: 'Ajio Seller', portalHint: 'seller portal (Reliance)' },
  { id: 'noon', name: 'noon Seller Lab', portalHint: 'login.noon.partners (UAE + KSA)' },
  { id: 'namshi', name: 'Namshi Seller', portalHint: 'noon group seller portal (UAE + KSA)' },
]);

/**
 * Build one stub connector by id.
 * @param {string} id channel id from STUB_CHANNELS
 * @param {{ getSecret?: () => Promise<{ secret?: string } | null> }} [opts]
 */
export function createChannelStub(id, opts = {}) {
  const def = STUB_CHANNELS.find((c) => c.id === id);
  if (!def) throw new Error(`unknown stub channel: ${id}`);
  return createStubConnector({ ...def, getSecret: opts.getSecret });
}

/** Build all stub connectors. @returns {Map<string, object>} id → connector */
export function createAllChannelStubs(optsById = {}) {
  const out = new Map();
  for (const def of STUB_CHANNELS) {
    out.set(def.id, createStubConnector({ ...def, getSecret: optsById[def.id]?.getSecret }));
  }
  return out;
}
