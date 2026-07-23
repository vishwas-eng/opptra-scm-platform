import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePackingPipeline } from '../src/pipeline.js';

const CFG = {
  GOOGLE_DELEGATED_USER: 'sca@opptra.com',
  WAREHOUSE_MAP: JSON.stringify({ Opp_RSG_MH: 'rsg@wh.com', Opp_WIQ_MH_1: 'wiq@wh.com' }),
};

function mockUc({ byFacility }) {
  return {
    async data(path, body, opts) {
      if (path.includes('fetchShippingPackageDetails')) return byFacility[opts.facility] || { shippingPackages: [] };
      return {};
    },
    async dataBinary() { return { contentType: 'application/pdf', buffer: Buffer.alloc(800, 37) }; }, // >500B PDF-ish
  };
}

test('not connected: returns a clear error, does not throw', async () => {
  const { createDrafts } = makePackingPipeline(mockUc({ byFacility: {} }), CFG, null);
  const r = await createDrafts(['SO1']);
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected on the server/);
});

test('groups SOs by warehouse and creates one draft per warehouse with invoices attached', async () => {
  const drafts = [];
  const google = { gmail: {} };
  // patch gmailApi via a fake google client: intercept createDraft through the wrapper
  const uc = mockUc({ byFacility: {
    Opp_RSG_MH: { shippingPackages: [{ invoiceCode: 'INV/RSG/1' }] }, // SO1, SO3 resolve here
    Opp_WIQ_MH_1: { shippingPackages: [{ invoiceCode: 'INV/WIQ/9' }] },
  } });
  // Make resolveInvoice deterministic per SO by returning different facilities:
  let call = 0;
  uc.data = async (path, body, opts) => {
    if (!path.includes('fetchShippingPackageDetails')) return {};
    // SO1/SO3 → RSG (first facility tried), SO2 → WIQ
    if (body.saleOrderCode === 'SO2') return opts.facility === 'Opp_WIQ_MH_1' ? { shippingPackages: [{ invoiceCode: 'INV/WIQ/9' }] } : { shippingPackages: [] };
    return opts.facility === 'Opp_RSG_MH' ? { shippingPackages: [{ invoiceCode: 'INV/RSG/1' }] } : { shippingPackages: [] };
  };

  const pipe = makePackingPipeline(uc, CFG, google);
  // stub the gmail wrapper by monkeypatching the imported module isn't trivial; instead
  // verify via the draft results using a gmail client that records createDraft calls.
  google.gmail = { users: { drafts: { create: async (a) => { drafts.push(a); return { data: { id: 'draft-' + drafts.length } }; } } } };

  const r = await pipe.createDrafts(['SO1', 'SO2', 'SO3']);
  assert.equal(r.ok, true);
  assert.equal(r.draftCount, 2);                 // RSG (SO1, SO3) + WIQ (SO2)
  const rsg = r.drafts.find((d) => d.to === 'rsg@wh.com');
  assert.deepEqual(rsg.sos, ['SO1', 'SO3']);
  assert.equal(rsg.attachmentCount, 2);          // one invoice PDF per SO
  assert.equal(drafts.length, 2);                // two Gmail drafts created
});

test('unresolved SOs are reported, not silently dropped', async () => {
  const google = { gmail: { users: { drafts: { create: async () => ({ data: { id: 'd1' } }) } } } };
  const uc = mockUc({ byFacility: {} }); // no facility has any invoice
  const pipe = makePackingPipeline(uc, CFG, google);
  const r = await pipe.createDrafts(['SOX']);
  assert.equal(r.ok, false);
  assert.equal(r.unresolved[0].so, 'SOX');
  assert.match(r.unresolved[0].reason, /no invoice/);
});
