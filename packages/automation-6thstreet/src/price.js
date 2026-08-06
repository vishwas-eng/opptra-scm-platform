/**
 * Selling price for 6th Street pack flow MUST come from the invoice only.
 * Never fall back to pick-list columns, UC snapshots, or other portals.
 *
 * Real OMS invoice sample (order 403770599): line Price (SAR) 85.00 + shipping 9 + platform fee 3.
 * Prefer explicit line/unit selling price fields; PDF text parsers may pass `text` / `rawText`.
 */

export function missingInvoicePrice(orderId, reason = 'invoice selling price missing') {
  return {
    ok: false,
    code: 'missingInvoicePrice',
    orderId: orderId || null,
    error: reason,
  };
}

function finiteMoney(n) {
  const x = Number(n);
  return Number.isFinite(x) && x >= 0 ? x : null;
}

/**
 * Parse IBM Store Engagement / 6th Street invoice PDF text.
 * Prefer unit line price; fall back to Amount column; never invent from pick list.
 */
export function parseSixthStreetInvoiceText(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const currency = /\bSAR\b/i.test(t) ? 'SAR' : undefined;
  const orderId =
    (t.match(/ORDER\s*NUMBER\s*[:\s]+(\d{6,})/i) || [])[1]
    || null;
  const invoiceNumber =
    (t.match(/Invoice\s*Number\s*[:\s]+(\d+)/i) || [])[1]
    || null;
  const sku =
    (t.match(/SKU\s*[:\s]*([A-Za-z0-9-]+)/i) || [])[1]
    || null;

  // "Price (SAR)" block then first money on following lines (sample layout)
  let sellingPrice = null;
  const priceBlock = t.match(/Price\s*\(\s*SAR\s*\)[\s\S]{0,120}?(\d+(?:\.\d+)?)/i);
  if (priceBlock) sellingPrice = finiteMoney(priceBlock[1]);

  if (sellingPrice == null) {
    const amountBlock = t.match(/Amount\s*\(\s*SAR\s*\)[\s\S]{0,120}?(\d+(?:\.\d+)?)/i);
    if (amountBlock) sellingPrice = finiteMoney(amountBlock[1]);
  }

  if (sellingPrice == null) {
    const m = t.match(/selling\s*price[:\s]+([0-9]+(?:\.[0-9]+)?)/i);
    if (m) sellingPrice = finiteMoney(m[1]);
  }

  if (sellingPrice == null) return null;

  return {
    sellingPrice,
    currency,
    orderId,
    invoiceNumber,
    sku,
    source: 'invoice-text-6thstreet',
  };
}

/**
 * Prefer structured invoice JSON; optionally parse 6th Street / generic invoice text.
 * @param {object|null} invoice
 * @returns {{ ok: true, sellingPrice: number, currency?: string, source?: string } | { ok: false, code: string, error: string }}
 */
export function extractInvoiceSellingPrice(invoice) {
  if (!invoice || typeof invoice !== 'object') {
    return missingInvoicePrice(null, 'no invoice payload');
  }
  const candidates = [
    invoice.sellingPrice,
    invoice.selling_price,
    invoice.unitSellingPrice,
    invoice.lineSellingPrice,
    invoice.price,
    invoice.totalSellingPrice,
  ];
  for (const c of candidates) {
    const n = finiteMoney(c);
    if (n != null) {
      return { ok: true, sellingPrice: n, currency: invoice.currency || invoice.curr || undefined, source: 'invoice' };
    }
  }
  if (typeof invoice.text === 'string' || typeof invoice.rawText === 'string') {
    const text = invoice.text || invoice.rawText;
    const parsed = parseSixthStreetInvoiceText(text);
    if (parsed) {
      return {
        ok: true,
        sellingPrice: parsed.sellingPrice,
        currency: parsed.currency || invoice.currency,
        source: parsed.source,
        orderId: parsed.orderId,
        invoiceNumber: parsed.invoiceNumber,
        sku: parsed.sku,
      };
    }
    const m = text.match(/selling\s*price[:\s]+([0-9]+(?:\.[0-9]+)?)/i);
    if (m) {
      const n = finiteMoney(m[1]);
      if (n != null) return { ok: true, sellingPrice: n, source: 'invoice-text' };
    }
  }
  return missingInvoicePrice(invoice.orderId || invoice.order_id, 'invoice has no selling price field');
}
