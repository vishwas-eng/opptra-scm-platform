import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceSellingPrice, missingInvoicePrice } from '../src/price.js';
import { makeSixthStreetPipeline } from '../src/pipeline.js';
import { buildPicklistXlsx } from '../src/picklistFile.js';
import { resolveStreet6UcTarget } from '../src/targets.js';

test('invoice selling price only, rejects empty', () => {
  const r = extractInvoiceSellingPrice(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missingInvoicePrice');
});

test('parses 6th Street OMS invoice PDF text (Price SAR)', () => {
  const text = `
6thStreet INVOICE
ORDER NUMBER : 403770599
Invoice Number: 403761095
Price (SAR) Discount (SAR) Qty Amount (SAR)
85.00 0.00 1.00 85.00
SKU: 5056791600146
Shipping Charges 9.00
Platform Fee 3.00
`;
  const r = extractInvoiceSellingPrice({ text });
  assert.equal(r.ok, true);
  assert.equal(r.sellingPrice, 85);
  assert.equal(r.currency, 'SAR');
  assert.equal(r.orderId, '403770599');
  assert.match(r.source, /6thstreet/);
});

test('classifyStreet6Filename recognizes SAC labels', async () => {
  const { classifyStreet6Filename, packAttachmentName } = await import('../src/artifacts.js');
  assert.equal(classifyStreet6Filename('SAC082604817.pdf'), 'label');
  assert.equal(classifyStreet6Filename('403770599 test.pdf'), 'invoice');
  assert.equal(packAttachmentName('403770599', 'label'), '403770599_label.pdf');
});

test('does not invent price from pick-list style objects', () => {
  // extractInvoiceSellingPrice must not be called with picklist rows as invoice
  const r = extractInvoiceSellingPrice({ sku: 'X', qty: 1, price: undefined });
  assert.equal(r.ok, false);
});

test('missingInvoicePrice helper', () => {
  const m = missingInvoicePrice('O9');
  assert.equal(m.orderId, 'O9');
  assert.equal(m.code, 'missingInvoicePrice');
});

test('UC target defaults to india', () => {
  const t = resolveStreet6UcTarget({ UC_BASE_URL: 'https://oppdoor.unicommerce.co.in', UC_USER: 'bot' });
  assert.equal(t.label, 'india');
  assert.equal(t.configured, true);
});

test('uae/ksa/staging do NOT fall back to India UC_USER', () => {
  const indiaOnly = {
    UC_BASE_URL: 'https://oppdoor.unicommerce.co.in',
    UC_USER: 'sc.automations@opptra.com',
    UC_PASS: 'india-only',
  };
  const uae = resolveStreet6UcTarget({ ...indiaOnly, STREET6_UC_INSTANCE: 'uae' });
  assert.equal(uae.label, 'uae');
  assert.equal(uae.configured, false);
  assert.equal(uae.user, '');
  assert.match(uae.baseUrl, /opptrauae/);

  const ksa = resolveStreet6UcTarget({ ...indiaOnly, STREET6_UC_INSTANCE: 'ksa' });
  assert.equal(ksa.label, 'ksa');
  assert.equal(ksa.configured, false);
  assert.equal(ksa.user, '');
  assert.match(ksa.baseUrl, /opptraksa/);

  const staging = resolveStreet6UcTarget({ ...indiaOnly, STREET6_UC_INSTANCE: 'staging' });
  assert.equal(staging.label, 'staging');
  assert.equal(staging.configured, false);
  assert.equal(staging.user, '');

  const withKsa = resolveStreet6UcTarget({
    ...indiaOnly,
    STREET6_UC_INSTANCE: 'ksa',
    HC_UC_KSA_USER: 'ksa-bot@opptra.com',
    HC_UC_KSA_PASS: 'ksa-secret',
  });
  assert.equal(withKsa.configured, true);
  assert.equal(withKsa.user, 'ksa-bot@opptra.com');
  assert.notEqual(withKsa.user, indiaOnly.UC_USER);
});

test('emailPack dry-run with injected artifacts uses invoice price', async () => {
  const pipe = makeSixthStreetPipeline(null, {
    STREET6_EMAIL_TO: 'daniyal@opptra.com',
    STREET6_DRY_RUN: true,
  }, null);

  const pick = await buildPicklistXlsx([{ sku: 'SKU1', quantity: 2, orderId: 'ORD1', customer: 'A', priceRef: 999 }]);
  const r = await pipe.emailPack({
    orderIds: ['ORD1'],
    dryRun: true,
    artifactsByOrder: {
      ORD1: {
        picklistBuffer: pick,
        invoiceBuffer: Buffer.from('%PDF-fake'),
        labelBuffer: Buffer.from('%PDF-label'),
        invoice: { sellingPrice: 42, orderId: 'ORD1' },
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.results[0].sellingPrice, 42);
  assert.equal(r.to, 'daniyal@opptra.com');
  assert.ok(r.preview.attachmentNames.includes('ORD1_picklist.xlsx'));
  assert.ok(r.preview.attachmentNames.includes('ORD1_invoice.pdf'));
  assert.ok(r.preview.attachmentNames.includes('ORD1_label.pdf'));
});

test('emailPack fails when invoice price missing even if picklist present', async () => {
  const pipe = makeSixthStreetPipeline(null, { STREET6_EMAIL_TO: 'daniyal@opptra.com' }, null);
  const r = await pipe.emailPack({
    orderIds: ['ORD2'],
    dryRun: true,
    artifactsByOrder: {
      ORD2: {
        picklistBuffer: Buffer.from('x'),
        invoice: { orderId: 'ORD2' }, // no price
      },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].code, 'missingInvoicePrice');
});

test('emailPack without artifacts reports awaitingHar', async () => {
  const pipe = makeSixthStreetPipeline(null, {}, null);
  const r = await pipe.emailPack({ orderIds: ['Z'], dryRun: true });
  assert.equal(r.awaitingHar, true);
});

test('STREET6_LIVE string false is not live', async () => {
  const pipe = makeSixthStreetPipeline(null, { STREET6_LIVE: 'false', STREET6_DRY_RUN: 'true' }, null);
  const s = await pipe.status();
  assert.equal(s.live, false);
  assert.equal(s.dryRunDefault, true);
});

test('resolveStreet6UcTarget ksa note recommends ksa for sample EAN', () => {
  const t = resolveStreet6UcTarget({
    STREET6_UC_INSTANCE: 'ksa',
    HC_UC_KSA_USER: 'scksa.automations@opptra.com',
    HC_UC_KSA_PASS: 'x',
    HC_UC_KSA_FACILITY: 'OPP_SLS_ML_KSA',
  });
  assert.equal(t.label, 'ksa');
  assert.equal(t.configured, true);
  assert.equal(t.facility, 'OPP_SLS_ML_KSA');
});

test('the region chosen in the UI beats the env default', async () => {
  // Choosing KSA and silently reading India stock would push the wrong warehouse's
  // numbers to a KSA storefront, which is worse than failing.
  const cfg = {
    STREET6_UC_INSTANCE: 'india',
    UC_BASE_URL: 'https://oppdoor.unicommerce.co.in',
    UC_USER: 'india-bot',
    HC_UC_KSA_USER: 'ksa-bot',
    HC_UC_KSA_PASS: 'x',
  };
  const p = makeSixthStreetPipeline(null, cfg, null);

  const ksa = await p.syncInventory({ dryRun: true, region: 'ksa' });
  assert.equal(ksa.ucTarget.label, 'ksa', 'must follow the requested region, not the env default');

  const dflt = await p.syncInventory({ dryRun: true });
  assert.equal(dflt.ucTarget.label, 'india', 'with no region requested, the env default still applies');
});

test('with no portal login it says so, instead of blaming a missing parameter', async () => {
  const p = makeSixthStreetPipeline(null, { HC_UC_KSA_USER: 'u', HC_UC_KSA_PASS: 'p' }, null);
  const r = await p.syncInventory({ dryRun: true, region: 'ksa' });
  assert.equal(r.ok, false);
  assert.equal(r.needsPortalLogin, true);
  assert.match(r.message, /download the current inventory/i);
});

test('download, fill, upload: the portal list drives the sync', async () => {
  // 6th Street publishes what it sells; we fill our quantities against exactly those
  // rows. The operator never supplies a SKU list.
  const portalClient = {
    catalogueSkus: async () => ({ ok: true, count: 3, skus: ['A1', 'B2', 'GONE'], rows: [] }),
    uploaded: null,
    uploadInventory: async function (rows) { this.uploaded = rows; return { ok: true, data: { importId: 99 } }; },
  };
  const uc = {
    public: async (_path, body) => ({
      inventorySnapshots: body.itemTypeSKUs
        .filter((s) => s !== 'GONE')
        .map((sku) => ({ itemTypeSKU: sku, inventory: 10, openSale: sku === 'A1' ? 4 : 0 })),
    }),
  };
  const cfg = { STREET6_UC_INSTANCE: 'india', UC_USER: 'bot', UC_BASE_URL: 'https://x', STREET6_LIVE: 'true' };
  const p = makeSixthStreetPipeline(uc, cfg, null, { portalClient });

  const dry = await p.syncInventory({ dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.listSource, 'portal', 'the SKU list came from the portal, not the caller');
  assert.equal(dry.skuCount, 3);
  assert.equal(dry.notInUc, 1, 'GONE is not in UC');
  assert.equal(portalClient.uploaded, null, 'a preview must never upload');

  const live = await p.syncInventory({ dryRun: false });
  assert.equal(live.uploaded, true);
  assert.equal(live.importRef, 99);
  // Sellable = on hand minus already promised, so A1 is 10-4, and a SKU UC does not
  // know becomes 0 rather than being dropped (dropping it leaves 6th Street selling
  // stock we do not have).
  assert.deepEqual(
    portalClient.uploaded.map((r) => [r.sku, r.count]),
    [['A1', 6], ['B2', 10], ['GONE', 0]],
  );
});

test('live writes stay behind STREET6_LIVE even when dryRun is false', async () => {
  const portalClient = {
    catalogueSkus: async () => ({ ok: true, count: 1, skus: ['A1'], rows: [] }),
    uploadInventory: async () => { throw new Error('must not upload'); },
  };
  const uc = { public: async () => ({ inventorySnapshots: [{ itemTypeSKU: 'A1', inventory: 5 }] }) };
  const p = makeSixthStreetPipeline(uc, { STREET6_UC_INSTANCE: 'india', UC_USER: 'b', UC_BASE_URL: 'https://x' }, null, { portalClient });
  const r = await p.syncInventory({ dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /STREET6_LIVE/);
});
