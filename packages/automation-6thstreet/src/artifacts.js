/**
 * Filename / artifact conventions from real 6th Street OMS pack samples
 * (order 403770599, invoice + shipping label, 2026-08-03).
 *
 * Invoice PDF: IBM Store Engagement export; often named `{orderId}….pdf`
 *   - Contains ORDER NUMBER, Invoice Number, line Price/Amount (SAR), SKU
 *   - Footer links to OMS ngstore home
 * Label PDF: courier label; filename often `SAC########.pdf`
 *   - Embeds order id + COD total (item + shipping + platform fee)
 */

export const STREET6_OMS_NGSTORE_HOME =
  'https://apg-oms.prod.coc.ibmcloud.com/wsc/ngstore/home.do?scFlag=Y';

export const STREET6_OMS_LOGIN =
  'https://apg-oms.prod.coc.ibmcloud.com/wsc/store/login.do';

/** Prefer ngstore home after login; login.do remains the auth entry. */
export function street6OmsHomeUrl(cfg = {}) {
  return cfg.STREET6_OMS_HOME_URL || STREET6_OMS_NGSTORE_HOME;
}

/**
 * Guess artifact kind from a downloaded filename (Path B / operator drops).
 * @param {string} filename
 * @returns {'invoice'|'label'|'picklist'|'unknown'}
 */
export function classifyStreet6Filename(filename) {
  const name = String(filename || '').trim();
  const base = name.split(/[/\\]/).pop() || '';
  const lower = base.toLowerCase();
  if (/\.xlsx?$/i.test(lower) || /pick\s*list|picklist/i.test(lower)) return 'picklist';
  if (/^sac\d+/i.test(base) || /[_-]label\.pdf$/i.test(lower) || /\blabel\b/i.test(lower)) return 'label';
  if (/invoice/i.test(lower) || /\d{6,}.*\.pdf$/i.test(lower)) return 'invoice';
  if (/\.pdf$/i.test(lower)) return 'unknown';
  return 'unknown';
}

/**
 * Build email attachment filenames (stable for Gmail + operators).
 * Real OMS exports may use SAC* for labels; we normalize on send.
 */
export function packAttachmentName(orderId, kind) {
  const id = String(orderId || 'order').trim();
  if (kind === 'picklist') return `${id}_picklist.xlsx`;
  if (kind === 'invoice') return `${id}_invoice.pdf`;
  if (kind === 'label') return `${id}_label.pdf`;
  return `${id}_${kind}`;
}

/**
 * Pull order id from invoice/label text when filename is opaque (e.g. SAC082604817.pdf).
 */
export function extractOrderIdFromPackText(text) {
  const t = String(text || '');
  const m =
    t.match(/ORDER\s*NUMBER\s*[:\s]+(\d{6,})/i)
    || t.match(/\b(40\d{7,})\b/); // 6th Street sample order ids are 9+ digit, often 40…
  return m ? m[1] : null;
}
