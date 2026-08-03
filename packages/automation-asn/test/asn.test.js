import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromSaleOrderDto, poFromDto } from '../src/rows.js';
import { writeFlipkart, writeMyntra, writeZepto } from '../src/writers.js';
import { makeAsnPipeline } from '../src/pipeline.js';

const dto = {
  code: 'SO02696', channel: 'Myntra_B2B', customerGSTIN: '29ZZZ',
  customFieldValues: [{ fieldName: 'PO', fieldValue: 'MYNJ-OTERVR240626-5' }],
  shippingPackages: [{ invoiceCode: 'SIRMH2627/0695', invoiceDate: '2026-07-22T10:00:00' }],
  saleOrderItems: [
    { itemSku: 'SKU1', channelProductId: 'FSN1', itemName: 'Shirt', completedQuantity: 3, maxRetailPrice: 999, sellingPriceWithoutTaxesAndDiscount: 500, taxPercentage: 12, hsnCode: '6109', ean: '890', imageUrl: 'http://x/1.jpg' },
    { itemSku: 'SKU1', completedQuantity: 2, taxPercentage: 12 }, // same SKU → aggregates qty
    { itemSku: 'SKU2', completedQuantity: 0, cancelledQuantity: 1, taxPercentage: 5 }, // cancelled → dropped
  ],
};

test('rowsFromSaleOrderDto aggregates by SKU, drops cancelled, splits tax', () => {
  const rows = rowsFromSaleOrderDto(dto, 'SO02696');
  assert.equal(rows.length, 1);          // SKU2 dropped (qty 0, cancelled)
  assert.equal(rows[0].item_sku, 'SKU1');
  assert.equal(rows[0].qty, 5);          // 3 + 2
  assert.equal(rows[0].cgst_rate, 6);    // 12 / 2
  assert.equal(rows[0].sgst_rate, 6);
  assert.equal(rows[0].invoice_code, 'SIRMH2627/0695');
});

test('poFromDto reads the PO custom field', () => {
  assert.equal(poFromDto(dto), 'MYNJ-OTERVR240626-5');
});

test('writers produce non-empty files of the right type', async () => {
  const rows = rowsFromSaleOrderDto(dto, 'SO02696');
  const fk = await writeFlipkart(rows, 'PO1', '2026-07-22');
  const my = await writeMyntra(rows, 'PO1', '2026-07-22');
  const zp = writeZepto(rows, 'PO1');
  assert.ok(fk.buffer.length > 100 && fk.filename.endsWith('.xlsx'));
  assert.ok(my.buffer.length > 100 && my.contentType.includes('spreadsheet'));
  assert.ok(zp.buffer.toString().startsWith('SKU Name,') && zp.filename.endsWith('.csv'));
});

test('pipeline hops facilities, compiles, returns base64 file', async () => {
  const uc = {
    async data(path, body, opts) {
      // only "Opp_WIQ_MH_1" has the order; RSG returns empty (tests the hop)
      if (opts.facility === 'Opp_WIQ_MH_1') return { saleOrderDTO: dto };
      return { shippingPackages: [] };
    },
  };
  const { compile } = makeAsnPipeline(uc, {});
  const r = await compile('SO02696', 'zepto');
  assert.equal(r.ok, true);
  assert.equal(r.facility, 'Opp_WIQ_MH_1');
  assert.equal(r.lineCount, 1);
  assert.ok(r.file.base64.length > 20);
  assert.equal(r.channel, 'zepto');
});

test('pipeline auto-detects the marketplace from the SO channel (no manual pick)', async () => {
  const uc = { async data() { return { saleOrderDTO: dto }; } }; // dto.channel = Myntra_B2B
  const { compile } = makeAsnPipeline(uc, {});
  const r = await compile('SO02696'); // no channel passed
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'myntra', 'detected from the SO, not chosen by the operator');
  assert.ok(r.file.filename.startsWith('Myntra_ASN_'));
});

test('pipeline refuses an SO on a channel with no ASN format, naming the channel', async () => {
  const amazonDto = { ...dto, channel: 'AMAZON_B2B' };
  const uc = { async data() { return { saleOrderDTO: amazonDto }; } };
  const { compile } = makeAsnPipeline(uc, {});
  const r = await compile('SO02696');
  assert.equal(r.ok, false);
  assert.match(r.error, /AMAZON_B2B/);
  assert.match(r.error, /Flipkart\/Myntra\/Zepto only/);
  assert.match(r.error, /Packing Mail/);
});

test('pipeline reports missing SO clearly', async () => {
  const uc = { async data() { return { shippingPackages: [] }; } };
  const { compile } = makeAsnPipeline(uc, {});
  const r = await compile('SO_NOPE');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});
