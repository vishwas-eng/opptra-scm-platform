// Return + re-dispatch pipeline — direct port of return-automation/src/pipeline.js
// (every endpoint + payload proven live). Differences from the original:
//   - all UC calls go through the injected UcClient (session/facility owned centrally)
//   - config comes in as an argument, not process.env reads scattered through the file
// The pipeline stays state-based and RESUMABLE: processSO reads the order's current
// state and advances it; a not-ready order returns { pending: true } and the worker
// re-enqueues it with a delay.

import { SessionError, ConfigError } from '@opptra/uc-client';

// safe() tolerates per-step business failures (the pipeline reads state and moves on),
// but a dead session or bad config must FAIL THE RUN FAST — otherwise the worker
// re-enqueues a doomed job for an hour while the session is dead.
const safe = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e instanceof SessionError || e instanceof ConfigError) throw e;
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeReturnPipeline(uc, cfgIn = {}) {
  const CFG = {
    channel: cfgIn.channel || process.env.SO_CHANNEL || 'CUSTOM_B2B',
    b2bCustomer: cfgIn.b2bCustomer || process.env.B2B_CUSTOMER || 'OPPB2B01',
    facility: cfgIn.facility || process.env.FACILITY || '',
    fillPool: cfgIn.fillPool ?? process.env.FILL_POOL !== '0',
    poolProvider: cfgIn.poolProvider || process.env.POOL_PROVIDER || 'CUSTOM',
    poolMethod: cfgIn.poolMethod || process.env.POOL_METHOD || 'Standard-Prepaid',
    allocPoll: Number(cfgIn.allocPoll || process.env.ALLOC_POLL || 4),
  };
  const fac = CFG.facility ? { facility: CFG.facility } : {};

  /* ---------- read order state ---------- */
  async function state(so) {
    const st = { status: null, pkg: null, pkgStatus: null, invoice: null, tracking: null };
    const sum = await safe(() => uc.data('/data/oms/saleorder/fetchSummary', { code: so }, fac));
    st.status = (sum?.saleOrderSummary || {}).status || null;
    const sh = await safe(() => uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: so }, fac));
    const p = (sh?.shippingPackages || [])[0];
    if (p) { st.pkg = p.code; st.pkgStatus = p.statusCode; st.invoice = p.invoiceCode; st.tracking = p.trackingNumber; }
    return st;
  }

  /* ---------- detect SKUs+qty from just the SO code ---------- */
  async function detectItems(so) {
    const sf = await safe(() => uc.data('/data/oms/b2b/sale-order/smart-fill/details', { saleOrderCodes: [so] }, fac));
    const list = sf?.skuList || [];
    if (list.length) return list.map((s) => ({ sku: s.skuCode, qty: (s.skuSummary || {}).orderedQuantity || 1 }));
    const cir = await safe(() => uc.data('/data/oms/returns-v2/manifest/saleOrder/cir/details/get', { saleOrderCode: so }, fac));
    const items = cir?.saleOrderItems || [];
    if (items.length) {
      const by = {};
      items.forEach((it) => { by[it.skuCode] = (by[it.skuCode] || 0) + (it.quantity || 1); });
      return Object.entries(by).map(([sku, qty]) => ({ sku, qty }));
    }
    return [];
  }

  async function fireAllocate(so, items) {
    if (CFG.channel === 'CUSTOM_B2B') {
      for (const it of items) {
        const bw = await safe(() => uc.dataGet('/data/wms/inventory/batchwise?skuCode=' + encodeURIComponent(it.sku), fac));
        const locs = bw?.batchwiseInventories || [];
        const pick = locs.find((l) => (l.availableQuantity || 0) >= it.qty) || locs[0] || { shelfCode: 'DEFAULT', batchCode: '' };
        await safe(() => uc.data('/data/wms/b2b/sale-order/smart-fill/orders/allocate', {
          allocationItems: [{
            saleOrderCode: so, shippingPackageCode: null,
            saleOrderItemCodeToInventoryAllocation: {
              [it.sku]: {
                inventory: it.qty,
                inventoryLocationData: [{ shelfCode: pick.shelfCode || 'DEFAULT', batchCode: pick.batchCode || '', inventory: String(it.qty) }],
              },
            },
          }],
        }, fac));
      }
    } else {
      const alloc = {};
      items.forEach((it) => { alloc[it.sku] = { inventory: it.qty }; });
      await safe(() => uc.data('/data/oms/saleorder/allocate/inventory', { saleOrderCode: so, saleOrderItemCodeToInventoryAllocation: alloc }, fac));
    }
  }

  function poolBatch(so) {
    const base = 'OPT' + String(so).replace(/[^0-9A-Za-z]/g, '').slice(-6).toUpperCase();
    return Array.from({ length: 5 }, (_, i) => base + String(i).padStart(2, '0'));
  }

  async function manifest(pkg, steps) { // create -> add -> close (close dispatches). Mandatory.
    const cr = await safe(() => uc.public('/services/rest/v1/oms/shippingManifest/create',
      { channel: CFG.channel, shippingProviderCode: CFG.poolProvider }, fac));
    const mc = cr && (cr.shippingManifestCode || cr.code);
    if (!mc) return null;
    await safe(() => uc.public('/services/rest/v1/oms/shippingManifest/addShippingPackage',
      { shippingManifestCode: mc, shippingPackageCodes: [pkg] }, fac));
    await safe(() => uc.public('/services/rest/v1/oms/shippingManifest/close', { shippingManifestCode: mc }, fac));
    steps.manifest = mc;
    return mc;
  }

  async function oldShipment(oldSO) {
    const sh = await safe(() => uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: oldSO }, fac));
    const p = (sh?.shippingPackages || [])[0];
    return p ? { code: p.code, trackingNumber: p.trackingNumber, shippingProviderCode: p.shippingProviderCode, ewbNo: p.ewbNo } : null;
  }

  async function runTail(so, st, steps, doDeliver, awbFromSO) {
    if (st.pkgStatus === 'DELIVERED') { steps.dispatch = 'ok'; steps.delivered = 'ok'; return st; }
    let reuseAwb = null;
    if (awbFromSO) {
      const old = await oldShipment(awbFromSO);
      if (old && old.trackingNumber) {
        reuseAwb = old.trackingNumber; steps.awbSource = awbFromSO;
        await safe(() => uc.data('/data/admin/shipping/add/awb',
          { shippingProviderCode: old.shippingProviderCode || CFG.poolProvider, shippingMethodName: CFG.poolMethod, awbNumberText: reuseAwb }, fac));
      }
    }
    if (st.pkgStatus !== 'DISPATCHED') {
      if (CFG.fillPool) {
        await safe(() => uc.data('/data/admin/shipping/add/awb',
          { shippingProviderCode: CFG.poolProvider, shippingMethodName: CFG.poolMethod, awbNumberText: poolBatch(so).join('\n') }, fac));
        steps.pool = 'topped';
      }
      const prov = await safe(() => uc.data('/data/oms/shipment/provider/allocate', { shippingPackageCode: st.pkg }, fac));
      if (prov && prov.trackingNumber) steps.awb = prov.trackingNumber;
      if (reuseAwb) {
        await safe(() => uc.data('/data/shipping/package/detail/update/awbNumber', { shippingPackageCode: st.pkg, trackingNumber: reuseAwb }, fac));
        steps.awb = reuseAwb + ' (reused from ' + awbFromSO + ')';
      }
      await manifest(st.pkg, steps); // MANDATORY manifest (close = dispatch)
      const s1 = await state(so);
      if (s1.pkgStatus !== 'DISPATCHED' && s1.pkgStatus !== 'DELIVERED') {
        await safe(() => uc.data('/data/oms/shipment/dispatch', { shippingPackageCode: st.pkg }, fac)); // fallback
      }
    }
    if (doDeliver) await safe(() => uc.data('/data/oms/shipment/markDelivered', { shippingPackageCode: st.pkg, podCode: 'POD-' + so }, fac));
    const s2 = await state(so);
    if (s2.pkgStatus === 'DISPATCHED') steps.dispatch = 'ok';
    if (s2.pkgStatus === 'DELIVERED') { steps.dispatch = 'ok'; steps.delivered = 'ok'; }
    return s2;
  }

  // return-in: reverse pickup + put-away + AUTO credit note (CIR), then complete put-away.
  async function bulkReturn(so, items, invoiceCode, steps) {
    const sum = await safe(() => uc.data('/data/oms/saleorder/fetchSummary', { code: so }, fac));
    const s = sum?.saleOrderSummary || {};
    const customer = s.customerCode || CFG.b2bCustomer;
    const channel = s.channel || CFG.channel;
    const r = await uc.data('/data/oms/returns/reversePickup/bulkReturn/create', {
      customerCode: customer, referenceCode: 'RET-' + so, bulkReturnReason: 'Return',
      bulkReturnId: null, channelCode: channel, saleOrderCode: so, putawayCode: null, putawayEnabled: true,
      lineItems: items.map((it) => ({ skuCode: it.sku, quantity: it.qty, inventoryType: 'GOOD_INVENTORY', returnReason: null })),
      invoiceCode: invoiceCode || null,
    }, fac);
    if (r.successful === false) throw new Error('bulk return: ' + JSON.stringify(r.errors || r));
    steps.bulkReturn = r.bulkReturnId;
    steps.reversePickups = (r.reversePickups || []).map((x) => x.reversePickupCode).join(', ');
    const di = await safe(() => uc.data('/data/oms/saleorder/fetchInvoiceDetails', { saleOrderCode: so }, fac));
    const cn = (di?.invoices || []).map((x) => x.code || x.invoiceCode).filter(Boolean).filter((code) => /^ISR|^CN|RET/i.test(code));
    if (cn.length) steps.creditNote = cn[cn.length - 1];
    const pt = r.putawayCode;
    if (pt) {
      steps.putaway = pt;
      await safe(() => uc.data('/data/putaway/manager/createPutawayList', { putawayCode: pt }, fac));
      const pc = await safe(() => uc.data('/data/putaway/complete', { putawayCode: pt }, fac));
      steps.inventoryBack = (pc && pc.successful !== false) ? 'restored' : 'pending';
    }
  }

  /* ---------- the one entry point (resumable) ---------- */
  async function processSO(so, options = {}) {
    const out = { saleOrder: so, steps: {}, ok: false };
    try {
      // DRY RUN: read-only preview. NO writes — reports state and the planned steps only.
      if (options.dryRun) {
        const st = await state(so);
        const items = await detectItems(so);
        out.dryRun = true;
        out.ok = true;
        out.pkgStatus = st.pkgStatus;
        out.invoiceCode = st.invoice;
        out.items = items;
        out.plan = [
          options.cancelSO ? `cancel ${options.cancelSO}` : null,
          !st.pkg ? `allocate ${items.map((i) => `${i.sku} x${i.qty}`).join(', ') || '(no items detected)'}` : `already allocated (pkg ${st.pkg})`,
          !st.invoice ? 'create invoice' : `already invoiced (${st.invoice})`,
          st.pkgStatus !== 'DISPATCHED' && st.pkgStatus !== 'DELIVERED' ? 'dispatch (+ manifest)' : null,
          (options.deliver !== false || options.returnIn) && st.pkgStatus !== 'DELIVERED' ? 'mark delivered' : null,
          options.returnIn ? 'bulk return + put-away' : null,
        ].filter(Boolean);
        out.steps.dryRun = out.plan.join(' → ');
        return out;
      }

      if (options.cancelSO) {
        await safe(() => uc.public('/services/rest/v1/oms/saleOrder/cancel', { saleOrderCode: options.cancelSO }, fac));
        out.steps.cancel = options.cancelSO;
      }
      let st = await state(so);

      if (!st.pkg) { // 1) allocate
        if (!st.status || st.status === 'CREATED') {
          const items = await detectItems(so);
          if (!items.length) { out.pending = true; out.steps.detect = 'order not processed yet, retrying'; return out; }
          out.items = items;
          out.steps.detect = items.map((i) => `${i.sku} x${i.qty}`).join(', ');
          await fireAllocate(so, items);
        } else {
          out.steps.detect = 'already ' + st.status;
        }
        for (let i = 0; i < CFG.allocPoll && !st.pkg; i++) { await sleep(1500); st = await state(so); }
        if (!st.pkg) { out.pending = true; out.steps.allocate = 'allocating (async, retrying)'; return out; }
      }
      out.shippingPackage = st.pkg;
      out.steps.allocate = st.pkg;

      if (!st.invoice) { // 2) invoice
        await safe(() => uc.public('/services/rest/v1/oms/shippingPackage/createInvoice', { shippingPackageCode: st.pkg }, fac));
        st = await state(so);
      }
      out.invoiceCode = st.invoice;
      out.steps.invoice = st.invoice || 'PACKED';

      const wantDeliver = options.deliver !== false || !!options.returnIn; // 3) dispatch; deliver if asked/returning
      if (st.pkgStatus !== 'DELIVERED' && !(st.pkgStatus === 'DISPATCHED' && !wantDeliver)) {
        st = await runTail(so, st, out.steps, wantDeliver, options.awbFromSO);
        const reached = wantDeliver ? (st.pkgStatus === 'DELIVERED') : (st.pkgStatus === 'DISPATCHED' || st.pkgStatus === 'DELIVERED');
        if (!reached) { out.pending = true; out.tracking = st.tracking; out.pkgStatus = st.pkgStatus; return out; }
      }

      if (options.returnIn && st.pkgStatus === 'DELIVERED') { // 4) bulk return + reassess
        const ritems = (out.items && out.items.length) ? out.items : await detectItems(so);
        if (ritems.length) await bulkReturn(so, ritems, out.invoiceCode, out.steps);
      }

      out.ok = true;
      out.tracking = st.tracking;
      out.pkgStatus = st.pkgStatus;
      return out;
    } catch (e) {
      out.error = String(e.message || e);
      return out;
    }
  }

  return { processSO, detectItems, state };
}
