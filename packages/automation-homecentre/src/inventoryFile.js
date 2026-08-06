// Vinculum "Update Pricing & Inventory" workbook helpers.
// Correct flow: download seller SKU list → fill Seller Inv from UAE UC → upload.
// Columns (sellerSkuImportDisplayDownloadImportTemplateBS):
// MarketPlace SkuCode | Vendor Sku Code | Sku Name | MRP | Selling Price | Seller Inv | Seller Code | …

import ExcelJS from 'exceljs';

const HEADERS = [
  'MarketPlace SkuCode',
  'Vendor Sku Code',
  'Sku Name',
  'MRP',
  'Selling Price',
  'Seller Inv',
  'Seller Code',
  'Sku Size',
  'Sku Color',
  'Web Sku Status',
];

/**
 * Map Vinculum seller-SKU row → UC skuCode for inventory lookup.
 * Identity on seller skuCode is proven for OppDoor UAE (151/151, 2026-08-04).
 * HC_SKU_MAP_JSON overrides when present; do not invent maps.
 */
export function resolveUcSkuForHcRow(hcRow, skuMap = {}) {
  const sellerSku = String(hcRow?.skuCode || '').trim();
  const mrkt = String(hcRow?.mrktSku || '').trim();
  if (sellerSku && skuMap[sellerSku]) return String(skuMap[sellerSku]);
  if (mrkt && skuMap[mrkt]) return String(skuMap[mrkt]);
  // Archive LAND* codes are order SKUs, not inventory list keys; identity only when listed.
  if (sellerSku && skuMap[sellerSku] === undefined) return sellerSku;
  return sellerSku || mrkt;
}

/**
 * Merge Vinculum seller list with UC qty map into import rows.
 * marketplaceSku = Vinculum mrktSku (required by portal update grid).
 * vendorSku = seller skuCode (T80358…); identical to UAE UC skuCode when identity holds.
 *
 * Qty rules: missing key → 0; negative / NaN → 0 and recorded in qtyErrors (never upload negatives).
 * `matched` = key present in ucQtyBySku (inventory/catalog probe), not "qty > 0".
 */
export function mergeSellerInventoryRows(hcSkus = [], ucQtyBySku = {}, opts = {}) {
  const skuMap = opts.skuMap || {};
  const sellerCodeDefault = opts.sellerCode != null ? String(opts.sellerCode) : '';
  const rows = [];
  const qtyErrors = [];
  let matched = 0;
  let missingUc = 0;
  for (const hc of hcSkus) {
    const ucSku = resolveUcSkuForHcRow(hc, skuMap);
    const hasQty = ucSku && Object.prototype.hasOwnProperty.call(ucQtyBySku, ucSku);
    if (hasQty) matched++;
    else missingUc++;
    let qty = 0;
    if (hasQty) {
      const raw = Number(ucQtyBySku[ucSku]);
      if (!Number.isFinite(raw) || Number.isNaN(raw)) {
        qtyErrors.push({ ucSku, reason: 'NaN/non-finite qty', raw: ucQtyBySku[ucSku] });
        qty = 0;
      } else if (raw < 0) {
        qtyErrors.push({ ucSku, reason: 'negative qty rejected', raw });
        qty = 0;
      } else {
        qty = Math.floor(raw);
      }
    }
    rows.push({
      marketplaceSku: String(hc.mrktSku || '').trim(),
      vendorSku: String(hc.skuCode || hc.mfgSku || '').trim(),
      skuName: String(hc.skuShortName || '').trim(),
      mrp: hc.mrp ?? '',
      sellingPrice: hc.salePrice ?? '',
      sellerInv: qty,
      sellerCode: sellerCodeDefault || String(hc.sellerCode || '').trim(),
      skuSize: String(hc.skuSize || '').trim(),
      skuColor: String(hc.skuColor || '').trim(),
      webSkuStatus: String(hc.webStatus || '').trim(),
      ucSku,
      hcIsbn: String(hc.isbn || '').trim(),
      matched: hasQty,
      priorSellerInv: Number(hc.qty || 0) || 0,
    });
  }
  return {
    rows,
    matched,
    missingUc,
    total: rows.length,
    matchPct: rows.length ? +(100 * matched / rows.length).toFixed(1) : 0,
    /** Fraction of seller rows with a UC qty key (0–1). */
    matchRate: rows.length ? matched / rows.length : 0,
    qtyErrors,
  };
}

/**
 * Structural + match-rate gate for Vinculum inventory upload.
 * Live upload must have matchRate === 1 (catalog identity) and zero validation errors.
 * Inventory-row absence at a facility is OK (qty 0) and is not what matchRate means here, * callers pass catalogMatchRate when gating live writes.
 */
export function validateInventoryFill(rows = [], opts = {}) {
  const errors = [];
  const expectedCount = opts.expectedCount;
  if (expectedCount != null && rows.length !== expectedCount) {
    errors.push(`row count ${rows.length} != expected ${expectedCount}`);
  }
  if (!rows.length) errors.push('no inventory rows');

  const vendorSeen = new Map();
  const mrktSeen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const vendor = String(r.vendorSku || '').trim();
    const mrkt = String(r.marketplaceSku || '').trim();
    const ucSku = String(r.ucSku || vendor || '').trim();
    const qty = r.sellerInv;

    if (!vendor) errors.push(`row ${i}: blank vendorSku/skuCode`);
    if (!mrkt) errors.push(`row ${i}: blank marketplaceSku/mrktSku`);
    if (vendor && /^LAND/i.test(vendor)) errors.push(`row ${i}: LAND* bleed in vendorSku=${vendor}`);
    if (mrkt && /^LAND/i.test(mrkt)) errors.push(`row ${i}: LAND* bleed in marketplaceSku=${mrkt}`);
    if (ucSku && /^LAND/i.test(ucSku)) errors.push(`row ${i}: LAND* bleed in ucSku=${ucSku}`);

    if (qty == null || qty === '') {
      errors.push(`row ${i} (${vendor}): blank sellerInv`);
    } else {
      const n = Number(qty);
      if (!Number.isFinite(n) || Number.isNaN(n)) errors.push(`row ${i} (${vendor}): sellerInv NaN`);
      else if (!Number.isInteger(n)) errors.push(`row ${i} (${vendor}): sellerInv not integer (${qty})`);
      else if (n < 0) errors.push(`row ${i} (${vendor}): negative sellerInv ${n}`);
    }

    if (vendor) vendorSeen.set(vendor, (vendorSeen.get(vendor) || 0) + 1);
    if (mrkt) mrktSeen.set(mrkt, (mrktSeen.get(mrkt) || 0) + 1);
  }

  for (const [k, n] of vendorSeen) {
    if (n > 1) errors.push(`duplicate vendorSku/skuCode ${k} (×${n})`);
  }
  for (const [k, n] of mrktSeen) {
    if (n > 1) errors.push(`duplicate marketplaceSku/mrktSku ${k} (×${n})`);
  }

  for (const qe of opts.qtyErrors || []) {
    errors.push(`qty error ${qe.ucSku}: ${qe.reason}`);
  }

  // Catalog identity match rate (0–1). Required === 1 before live upload.
  const matchRate = opts.catalogMatchRate != null
    ? Number(opts.catalogMatchRate)
    : (opts.matchRate != null ? Number(opts.matchRate) : null);

  if (matchRate != null && !(matchRate === 1)) {
    errors.push(`matchRate ${matchRate} !== 1 (refuse live upload until 100% catalog match)`);
  }

  return {
    ok: errors.length === 0,
    errors,
    matchRate,
    total: rows.length,
  };
}

export async function buildInventoryXlsx(rows = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Inventory');
  ws.addRow(HEADERS);
  for (const r of rows) {
    ws.addRow([
      r.marketplaceSku || '',
      r.vendorSku || r.marketplaceSku || '',
      r.skuName || '',
      r.mrp ?? '',
      r.sellingPrice ?? '',
      r.sellerInv ?? 0,
      r.sellerCode || '',
      r.skuSize || '',
      r.skuColor || '',
      r.webSkuStatus || '',
    ]);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
