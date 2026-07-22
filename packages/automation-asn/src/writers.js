// ASN file writers — produce a downloadable file per channel. Flipkart/Myntra are
// XLSX (exceljs, incl. Myntra's total-cost formulas); Zepto is CSV. Each returns
// { filename, contentType, buffer }.
import ExcelJS from 'exceljs';

const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const csvEsc = (s) => {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export async function writeFlipkart(rows, po, dateStr) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('packaging_template');
  ws.addRow(['channel product id', 'item sku code', 'product master', 'product master', 'blank', 'completed qty', 'exclusive gst selling price', 'product master', 'invoice', 'PO']);
  ws.addRow(['FSN', 'Article Code', 'EAN Code', 'MRP', 'Size', 'Qty', 'Unit Price', 'Tax %', 'Invoice No', 'PO No']).font = { bold: true };
  for (const r of rows) {
    ws.addRow([r.channel_product_id, r.item_sku, r.ean || '', r.mrp || '', r.size || '', r.qty,
      r.unit_price_ex_tax ? round(r.unit_price_ex_tax, 6) : '', r.tax_pct || '', r.invoice_code, r.po || po]);
  }
  return { filename: `Flipkart_packaging_${po}_${dateStr}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

export async function writeMyntra(rows, po, dateStr) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(po).slice(0, 31));
  ws.addRow(['Slot Date (yyyy-MM-dd)', 'PO Barcode/STR Barcode', 'Vendor GST Registration No', 'SKU Code', 'HSN Code',
    'Invoice No/STN Invoice No', 'Invoice Date (yyyy-MM-dd)', 'Quantity', 'Unit Price Excluding Taxes',
    'Total Cost Excluding Taxes [Qnty * Unit Price]', 'CGST Rate', 'SGST Rate', 'IGST Rate', 'Total Cost Including GST', 'Carton Number']).font = { bold: true };
  const vendor = rows.find((r) => r.vendor_gstin)?.vendor_gstin || '';
  rows.forEach((row, i) => {
    const excelR = i + 2;
    const taxMult = 1 + (Number(row.tax_pct) || 0) / 100;
    ws.addRow([row.slot_date || '', row.po || po, row.vendor_gstin || vendor,
      row.channel_product_id || row.item_sku, row.hsn || '', row.invoice_code || '', row.invoice_date || '',
      row.qty, row.unit_price_ex_tax ? round(row.unit_price_ex_tax, 2) : '',
      { formula: `I${excelR}*H${excelR}` }, row.cgst_rate || 0, row.sgst_rate || 0, row.igst_rate || 0,
      { formula: `J${excelR}*${taxMult}` }, i + 1]);
  });
  return { filename: `Myntra_ASN_${po}_${dateStr}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

export function writeZepto(rows, po) {
  const lines = ['SKU Name,SKU Code,SKU Image Url,Po Quantity,Asn Quantity,Po MRP,EAN Number'];
  for (const r of rows) {
    lines.push([csvEsc(r.item_name), csvEsc(r.channel_product_id || r.item_sku), csvEsc(r.image_url || ''), r.qty, r.qty, r.mrp || '', r.ean || ''].join(','));
  }
  return { filename: `Zepto_ASN_${po}.csv`, contentType: 'text/csv', buffer: Buffer.from(lines.join('\n'), 'utf8') };
}
