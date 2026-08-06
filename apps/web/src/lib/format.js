// Presentation helpers shared across screens.

export const STATUS_LABEL = {
  queued: 'Waiting',
  running: 'Working…',
  pending_retry: 'Retrying…',
  succeeded: 'Done',
  failed: 'Failed',
};

export const AUTOMATION_LABEL = {
  asn: 'ASN Compile',
  reversedc: 'Reverse DC',
  packing: 'Packing Mail',
  sheet: 'Sheet Update',
  ewaybill: 'E-way Bill',
  return: 'Return Flow',
  inventory: 'Inventory',
  inward: 'Inward',
  outward: 'Outward',
  uc: 'Order Lookup',
  'connector-unicommerce': 'Unicommerce',
  homecentre: 'Home Centre',
  '6thstreet': '6th Street',
};

export function automationLabel(a) {
  return AUTOMATION_LABEL[a] || a || '—';
}

/** Short, unambiguous timestamp in the team's local convention. */
export function fmtDate(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** "3 min ago" for live surfaces where the exact clock time is noise. */
export function fmtRelative(t) {
  if (!t) return '';
  const ms = Date.now() - new Date(t).getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Turn a run's JSON input into words. Operators should never have to read raw JSON to
 * know which order a row is about.
 */
export function shortInput(input) {
  if (!input) return '';
  let o = input;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return o.slice(0, 30); }
  }
  if (typeof o !== 'object' || o === null) return String(o);
  if (o.saleOrder || o.code || o.so) return String(o.saleOrder || o.code || o.so);
  if (Array.isArray(o.saleOrders)) return `${o.saleOrders.length} order${o.saleOrders.length === 1 ? '' : 's'}`;
  if (Array.isArray(o.rows)) return `${o.rows.length} row${o.rows.length === 1 ? '' : 's'}`;
  if (Array.isArray(o.items)) return `${o.items.length} item${o.items.length === 1 ? '' : 's'}`;
  if (o.count) return String(o.count);
  if (o.file || o.filename) return 'uploaded file';
  if (o.action) return String(o.action);
  const firstString = Object.values(o).find((v) => typeof v === 'string' && v);
  return firstString ? String(firstString).slice(0, 30) : '';
}

/** Split a pasted list of sale orders on whitespace, commas or semicolons. */
export function parseSoList(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse "SKU, qty, unitPrice[, sellingPrice]" lines into item objects. */
export function parseItems(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sku, quantity, unitPrice, sellingPrice] = line.split(/[,\t]/).map((s) => s.trim());
      const item = { sku, quantity: Number(quantity) || 0 };
      if (unitPrice) item.unitPrice = Number(unitPrice);
      if (sellingPrice) item.sellingPrice = Number(sellingPrice);
      return item;
    })
    .filter((i) => i.sku);
}

/**
 * Decode a base64 file payload into an object URL.
 * Caller owns the URL and MUST revoke it (see useObjectUrl).
 */
export function fileToObjectUrl(file) {
  if (!file?.base64) return null;
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: file.contentType || 'application/octet-stream' }));
}

/** Strip base64 blobs before showing raw JSON — they are megabytes of noise. */
export function withoutBase64(obj) {
  return JSON.parse(JSON.stringify(obj ?? null, (k, v) => (
    k === 'base64' && typeof v === 'string' ? '…' : v
  )));
}
