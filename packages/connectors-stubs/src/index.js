// @opptra/connectors-stubs, channels not yet cracked, with an honest record of HOW
// each one can actually be reached.
//
// The `transport` field is the important part. Research (2026-08-06, see
// docs/CONNECTOR-DOCTRINE.md) established that most of these channels have no seller
// API at all, and that the industry-standard transport for Indian quick commerce is
// email PO parsing, not portal scraping. Recording that here stops a future session
// from burning a week reverse-engineering a portal whose data arrives by email anyway.
//
// When a channel gets real endpoints it graduates to its own package (the
// connectors-amazon path) and its row here is deleted.
import { createStubConnector } from '@opptra/connectors-sdk';

/**
 * transport:
 *   'official', a documented seller API exists; build against it, never scrape.
 *   'partner', an API exists but access is granted per-integrator/vendor-id.
 *   'email-po', POs arrive as emailed PDF/XLSX. Parse the mailbox; the portal is
 *                 secondary. This is how Unicommerce, EasyEcom and Fynd all do it.
 *   'portal', no API and no email feed found; portal session is the only route.
 *
 * `viaUnicommerce: true` means Unicommerce already ingests this channel, so riding our
 * existing UC connector beats building a direct one. What UC does NOT give us is
 * appointments, GRN reconciliation, fill-rate/OTIF and debit-note disputes, that gap
 * is the actual product opportunity, not the PO import.
 */
export const STUB_CHANNELS = Object.freeze([
  // --- marketplaces ---
  {
    id: 'nykaa',
    name: 'Nykaa Seller',
    portalHint: 'seller.nykaa.com',
    transport: 'portal',
  },
  {
    id: 'meesho',
    name: 'Meesho Supplier',
    portalHint: 'supplier.meesho.com',
    transport: 'portal',
  },
  {
    id: 'ajio',
    name: 'Ajio Seller',
    portalHint: 'Reliance seller portal',
    transport: 'portal',
  },
  {
    id: 'noon',
    name: 'noon Seller Lab',
    portalHint: 'noon Seller Lab (UAE + KSA)',
    transport: 'portal',
  },
  {
    id: 'namshi',
    name: 'Namshi Seller',
    portalHint: 'noon group seller portal (UAE + KSA)',
    transport: 'portal',
  },

  // --- Indian quick commerce ---
  // None of these publish a self-serve vendor API. Do not plan a scraping-first build.
  {
    id: 'blinkit',
    name: 'Blinkit',
    portalHint: 'seller.blinkit.com (Seller Hub)',
    transport: 'partner',
    viaUnicommerce: true,
    note: 'Real partner API, but Blinkit whitelists a Vendor ID per integrator; POs still arrive as PDF.',
  },
  {
    id: 'zepto',
    name: 'Zepto',
    portalHint: 'brands.zepto.co.in',
    transport: 'email-po',
    viaUnicommerce: true,
    note: 'Portal is behind an AWS WAF JS challenge. POs come by email as PDF.',
  },
  {
    id: 'instamart',
    name: 'Swiggy Instamart',
    portalHint: 'partner.instamart.in',
    transport: 'email-po',
    viaUnicommerce: true,
    note: 'Portal uses a custom x-oztok header. POs come by email as PDF.',
  },
  {
    id: 'bigbasket',
    name: 'BigBasket (BB Sambandh)',
    portalHint: 'nucleus.bigbasket.com',
    transport: 'email-po',
    viaUnicommerce: true,
    note: 'Portal is reCAPTCHA v3 gated. PO/GRN/GDN/PRN all arrive by email; POs are XLSX.',
  },
  {
    id: 'flipkart-minutes',
    name: 'Flipkart Minutes',
    portalHint: 'quick-commerce arm of Flipkart',
    transport: 'email-po',
    viaUnicommerce: true,
    note: "Do NOT use Flipkart's hyperlocal listings API, that is Flipkart Quick (2018), not Minutes.",
  },
  {
    id: 'jiomart',
    name: 'JioMart Seller',
    portalHint: 'seller.jiomart.com',
    transport: 'partner',
    note: 'Credentials issued by the JioMart category manager. Marketplace flow, NOT JioMart Express dark stores.',
  },
]);

const DEFAULT_ACTIONS = ['orders.search', 'inventory.get'];
// A channel whose real feed is emailed POs needs a different action shape: there is no
// orders endpoint to call, there are purchase orders to ingest and acknowledge.
const EMAIL_PO_ACTIONS = ['purchaseOrders.list', 'purchaseOrders.get', 'appointments.list'];

function actionsFor(def) {
  return def.transport === 'email-po' ? EMAIL_PO_ACTIONS : DEFAULT_ACTIONS;
}

/**
 * Build one stub connector by id.
 * @param {string} id channel id from STUB_CHANNELS
 * @param {{ getSecret?: () => Promise<{ secret?: string } | null> }} [opts]
 */
export function createChannelStub(id, opts = {}) {
  const def = STUB_CHANNELS.find((c) => c.id === id);
  if (!def) throw new Error(`unknown stub channel: ${id}`);
  return createStubConnector({ ...def, actions: actionsFor(def), getSecret: opts.getSecret });
}

/** Build all stub connectors. @returns {Map<string, object>} id → connector */
export function createAllChannelStubs(optsById = {}) {
  const out = new Map();
  for (const def of STUB_CHANNELS) {
    out.set(def.id, createStubConnector({
      ...def,
      actions: actionsFor(def),
      getSecret: optsById[def.id]?.getSecret,
    }));
  }
  return out;
}
