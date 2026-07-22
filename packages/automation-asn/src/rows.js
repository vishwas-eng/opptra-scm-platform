// ASN row mapping — pure functions, ported from b2b AsnFill.gs (asnRowsFromSaleOrderDto_).
// No I/O here so it's fully unit-testable; the pipeline handles fetch + file generation.

const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => Number(v) || 0;

/** PO from the SO DTO's custom fields (falls back to channel shipment code). */
export function poFromDto(dto) {
  const cfs = (dto && dto.customFieldValues) || [];
  for (const cf of cfs) {
    const n = String(cf.fieldName || cf.displayName || '').toUpperCase();
    if (n === 'PO' || n.startsWith('PO') || n.includes('PURCHASE')) {
      const v = str(cf.fieldValue);
      if (v && v !== 'null' && v !== 'None') return v;
    }
  }
  const pkgs = (dto && dto.shippingPackages) || [];
  if (pkgs[0] && pkgs[0].channelShipmentCode) return String(pkgs[0].channelShipmentCode);
  return '';
}

export function invoiceFromDto(dto) {
  const pkgs = (dto && dto.shippingPackages) || [];
  for (const p of pkgs) {
    const inv = p.invoiceCode || p.invoiceDisplayCode || '';
    if (inv) return String(inv);
  }
  return '';
}

/** Map a saleOrderDTO to ASN template rows (one per SKU, qty aggregated). */
export function rowsFromSaleOrderDto(dto, soCode) {
  const items = (dto && dto.saleOrderItems) || [];
  const inv = invoiceFromDto(dto);
  const po = poFromDto(dto);
  const channel = dto.channel || dto.channelCode || '';
  const facility = items[0] ? (items[0].facilityCode || items[0].facilityName || '') : '';

  const pkgs = dto.shippingPackages || [];
  const invDate = pkgs[0] && pkgs[0].invoiceDate ? String(pkgs[0].invoiceDate).slice(0, 10) : '';
  let slot = dto.appointmentDate ? String(dto.appointmentDate).slice(0, 10) : '';
  if (!slot && dto.displayOrderDateTime) slot = String(dto.displayOrderDateTime).slice(0, 10);

  const bySku = {};
  items.forEach((it = {}, i) => {
    let sku = str(it.itemSku || it.sellerSkuCode || it.channelProductId);
    if (!sku) sku = `LINE_${i}`;
    if (!bySku[sku]) {
      const taxPct = num(it.taxPercentage);
      const row = {
        so: dto.code || soCode, channel, facility: it.facilityCode || facility,
        channel_product_id: String(it.channelProductId || sku), item_sku: sku,
        item_name: str(it.itemName), size: '', qty: 0,
        mrp: num(it.maxRetailPrice || it.channelMrp),
        unit_price_ex_tax: num(it.sellingPriceWithoutTaxesAndDiscount),
        hsn: str(it.hsnCode), tax_pct: taxPct,
        cgst_rate: taxPct > 0 ? taxPct / 2 : 0, sgst_rate: taxPct > 0 ? taxPct / 2 : 0, igst_rate: 0,
        invoice_code: inv, invoice_date: invDate, vendor_gstin: '',
        customer_gstin: str(dto.customerGSTIN), po, slot_date: slot,
        ean: str(it.ean), image_url: str(it.imageUrl || it.channelProductImageUrl),
      };
      if (!row.unit_price_ex_tax && it.sellingPrice) {
        const sp = num(it.sellingPrice);
        row.unit_price_ex_tax = taxPct > 0 ? sp / (1 + taxPct / 100) : sp;
      }
      bySku[sku] = row;
    }
    let q = 1;
    if (it.completedQuantity != null && it.completedQuantity !== '') q = num(it.completedQuantity);
    else if (it.totalQuantity != null && it.totalQuantity !== '') q = num(it.totalQuantity);
    else if (it.quantity != null) q = num(it.quantity);
    const cancelled = num(it.cancelledQuantity);
    if (cancelled > 0 && q <= 0) return; // skip fully cancelled lines
    bySku[sku].qty += q;
  });

  return Object.values(bySku).filter((r) => r.qty > 0);
}
