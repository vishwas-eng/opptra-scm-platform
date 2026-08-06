// Connector catalogue shown on the Connectors page.
//
// Every platform Opptra touches appears here so operators can see the roadmap, but only
// LIVE_CONNECTOR_IDS may be connected or expose Agent tools. A connector goes live only
// after a real session test against the real portal — never because a scaffold exists.

export const LIVE_CONNECTOR_IDS = Object.freeze([
  'google-sheets',
  'google-drive',
  'unicommerce',
  'waypoint',
  'homecentre',
]);

export function isLiveConnector(id) {
  return LIVE_CONNECTOR_IDS.includes(String(id || ''));
}

/** Connectors whose Layer-B bindings (specific sheets / folders) the Agent is scoped to. */
export const RESOURCE_CONNECTOR_IDS = Object.freeze(['google-sheets', 'google-drive']);

export function isResourceConnector(id) {
  return RESOURCE_CONNECTOR_IDS.includes(String(id || ''));
}

export const CONNECTOR_META = Object.freeze([
  { id: 'google-sheets', name: 'Google Sheets', group: 'live', icon: 'GS', authKind: 'oauth2', connectMode: 'google-user', live: true, blurb: 'Read & write your spreadsheets' },
  { id: 'google-drive', name: 'Google Drive', group: 'live', icon: 'GD', authKind: 'oauth2', connectMode: 'google-user', live: true, blurb: 'Search & download your Drive files' },
  { id: 'unicommerce', name: 'Unicommerce', group: 'live', icon: 'UC', authKind: 'session', connectMode: 'uc-session', live: true, blurb: 'OMS session health & orders' },
  { id: 'waypoint', name: 'Waypoint', group: 'live', icon: 'WP', authKind: 'db', connectMode: 'env', live: true, blurb: 'Sale-order source of truth' },
  { id: 'homecentre', name: 'Home Centre', group: 'live', icon: 'HC', authKind: 'basic', connectMode: 'env', live: true, blurb: 'Vinculum seller portal' },
  // connectMode drives which Connect affordance the UI offers:
  //   'oauth-amazon' → one-time Seller Central authorization (official grant)
  //   'capture'      → log in once with the Capture extension; we blueprint the portal
  { id: 'amazon', name: 'Amazon Seller Central', group: 'marketplace', icon: 'AZ', authKind: 'oauth2', connectMode: 'oauth-amazon', live: false, blurb: 'SP-API · India, UAE, KSA' },
  { id: 'flipkart', name: 'Flipkart Seller Hub', group: 'marketplace', icon: 'FK', authKind: 'dual', connectMode: 'capture', live: false, blurb: 'Seller Hub / Seller API' },
  { id: 'myntra', name: 'Myntra Partner', group: 'marketplace', icon: 'MY', authKind: 'session', connectMode: 'capture', live: false, blurb: 'Partner portal + ASN' },
  { id: 'nykaa', name: 'Nykaa Seller', group: 'marketplace', icon: 'NY', authKind: 'session', connectMode: 'capture', live: false, blurb: 'Seller portal' },
  // Quick commerce is its own group because it works differently: no vendor APIs, POs
  // arrive by email, and Unicommerce already ingests most of them.
  { id: 'blinkit', name: 'Blinkit', group: 'quickcommerce', icon: 'BK', authKind: 'session', connectMode: 'partner', live: false, blurb: 'Partner API · vendor ID whitelisted' },
  { id: 'zepto', name: 'Zepto', group: 'quickcommerce', icon: 'ZP', authKind: 'email', connectMode: 'email-po', live: false, blurb: 'PO by email (PDF)' },
  { id: 'instamart', name: 'Swiggy Instamart', group: 'quickcommerce', icon: 'IM', authKind: 'email', connectMode: 'email-po', live: false, blurb: 'PO by email (PDF)' },
  { id: 'bigbasket', name: 'BigBasket', group: 'quickcommerce', icon: 'BB', authKind: 'email', connectMode: 'email-po', live: false, blurb: 'BB Sambandh · PO by email (XLSX)' },
  { id: 'flipkart-minutes', name: 'Flipkart Minutes', group: 'quickcommerce', icon: 'FM', authKind: 'email', connectMode: 'email-po', live: false, blurb: 'PO by email (XLSX)' },
  { id: 'jiomart', name: 'JioMart Seller', group: 'marketplace', icon: 'JM', authKind: 'session', connectMode: 'partner', live: false, blurb: 'Credentials from category manager' },
  { id: 'meesho', name: 'Meesho Supplier', group: 'marketplace', icon: 'MS', authKind: 'session', connectMode: 'capture', live: false, blurb: 'Supplier portal' },
  { id: 'ajio', name: 'Ajio Seller', group: 'marketplace', icon: 'AJ', authKind: 'session', connectMode: 'capture', live: false, blurb: 'Reliance seller portal' },
  { id: 'noon', name: 'noon Seller Lab', group: 'marketplace', icon: 'NN', authKind: 'session', connectMode: 'capture', live: false, blurb: 'UAE + KSA marketplace' },
  { id: 'namshi', name: 'Namshi Seller', group: 'marketplace', icon: 'NM', authKind: 'session', connectMode: 'capture', live: false, blurb: 'UAE + KSA fashion (noon group)' },
  { id: '6thstreet', name: '6th Street', group: 'marketplace', icon: '6S', authKind: 'session', connectMode: 'capture', live: false, blurb: 'VPN + seller portal / IBM OMS pack email' },
]);

/** Marketplace ids that must be refused even if a tool name for them is somehow requested. */
export const COMING_SOON_IDS = Object.freeze(
  CONNECTOR_META.filter((c) => !c.live).map((c) => c.id),
);
