import ExcelJS from 'exceljs';

/** Minimal pick-list workbook. Price column is informational only, pack uses invoice price. */
const HEADERS = ['SKU', 'Quantity', 'Order ID', 'Customer', 'Price (ref only, use invoice)'];

export async function buildPicklistXlsx(rows = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PickList');
  ws.addRow(HEADERS);
  for (const r of rows) {
    ws.addRow([
      r.sku || r.item || '',
      r.quantity ?? r.qty ?? '',
      r.orderId || r.order_id || '',
      r.customer || r.customerName || '',
      r.priceRef ?? '',
    ]);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
