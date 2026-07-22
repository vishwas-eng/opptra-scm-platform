// Inward / Outward / Full-cycle — ported from appscript/{Inward,Outward,FullCycle}.gs.
//
// Layers: uc.public = OAuth bearer (/services/rest/v1); uc.data = JSESSIONID (/data).
// Idempotent per reqId via the injected memoStep(): a retry resumes and never
// double-creates a PO / double-invoices / double-adds stock.
//
//   INWARD (ADJUST):      createApproved PO → (opt GRN trail) → inventory/adjust ADD → verify
//   INWARD (GRN_PUTAWAY): PO → GRN → addItemSKU → sendForQC → getInflowReceipt → qc/complete
//                         → putaway create/add/list/complete → verify
//   OUTWARD:              create SO (B2C CUSTOM, one item per unit) → allocate → invoice/pkg → verify
//   FULL-CYCLE:           inward, then (only if it succeeds) outward

const nowIsoUtc = () => new Date().toISOString();

export function makeInventoryPipeline(uc, cfg, memoStep) {
  const CFG = {
    vendorCode: cfg.UC_VENDOR_CODE,
    shelfCode: cfg.UC_SHELF_CODE || 'DEFAULT',
    currency: cfg.UC_CURRENCY || 'INR',
    taxCode: cfg.UC_TAX_CODE || undefined,
    inwardMode: (cfg.UC_INWARD_MODE || 'ADJUST').toUpperCase(),
    grnTrail: cfg.UC_GRN_TRAIL !== false,
    outwardChannel: cfg.UC_OUTWARD_CHANNEL || 'CUSTOM',
    outwardShipMethod: cfg.UC_OUTWARD_SHIP_METHOD || 'STD',
    facility: cfg.UC_DEFAULT_FACILITY || '',
  };
  const fac = CFG.facility ? { facility: CFG.facility } : {};

  async function snapshot(skus) {
    const snap = await uc.public('/services/rest/v1/inventory/inventorySnapshot/get', { itemTypeSKUs: skus }, { idempotent: true });
    const inv = {};
    (snap.inventorySnapshots || []).forEach((s) => { inv[s.itemTypeSKU] = s.inventory; });
    return inv;
  }

  /* ------------------------------- INWARD ------------------------------- */

  async function inwardAdjust(form) {
    const { reqId, items } = form;
    const poCode = await memoStep(reqId, 'PO', async () => {
      const r = await uc.public('/services/rest/v1/purchase/purchaseOrder/createApproved', {
        vendorCode: CFG.vendorCode, currencyCode: CFG.currency,
        purchaseOrderItems: items.map((it) => ({
          itemSKU: it.sku, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice),
          maxRetailPrice: it.maxRetailPrice ? Number(it.maxRetailPrice) : undefined,
          taxTypeCode: it.taxCode || CFG.taxCode || undefined,
        })),
      });
      return r.purchaseOrderCode;
    });

    let grnCode = null;
    if (CFG.grnTrail) {
      grnCode = await memoStep(reqId, 'GRN', async () => {
        const r = await uc.public('/services/rest/v1/purchase/inflowReceipt/create', {
          wsGRN: { vendorInvoiceNumber: form.vendorInvoiceNumber || `INV-${reqId}`, vendorInvoiceDate: form.vendorInvoiceDate || nowIsoUtc(), currencyCode: CFG.currency },
          purchaseOrderCode: poCode, vendorInvoiceDateCheckDisable: true,
        });
        return r.inflowReceiptCode;
      });
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await memoStep(reqId, `GRNITEM_${i}`, async () => {
          await uc.public('/services/rest/v1/purchase/inflowReceipt/addItemSKU', {
            inflowReceiptCode: grnCode, inflowReceiptItem: { quantity: Number(it.quantity), unitPrice: Number(it.unitPrice), skuCode: it.sku },
          });
          return 'ok';
        });
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await memoStep(reqId, `ADJUST_${i}`, async () => {
        await uc.public('/services/rest/v1/inventory/adjust', {
          inventoryAdjustment: { itemSKU: it.sku, quantity: Number(it.quantity), shelfCode: CFG.shelfCode, inventoryType: 'GOOD_INVENTORY', adjustmentType: 'ADD', remarks: `inward ${reqId}${poCode ? ' PO ' + poCode : ''}` },
        });
        return 'ok';
      });
    }

    const inventory = await snapshot(items.map((it) => it.sku));
    return { reqId, mode: 'ADJUST', poCode, grnCode, putawayCode: null, inventory, status: 'INWARD_DONE' };
  }

  async function inwardPutaway(form) {
    const { reqId, items } = form;
    const poCode = await memoStep(reqId, 'PO', async () =>
      (await uc.public('/services/rest/v1/purchase/purchaseOrder/createApproved', {
        vendorCode: CFG.vendorCode, currencyCode: CFG.currency,
        purchaseOrderItems: items.map((it) => ({
          itemSKU: it.sku, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice),
          maxRetailPrice: it.maxRetailPrice ? Number(it.maxRetailPrice) : undefined,
          taxTypeCode: it.taxCode || CFG.taxCode || undefined,
        })),
      })).purchaseOrderCode);

    const grnCode = await memoStep(reqId, 'GRN', async () =>
      (await uc.public('/services/rest/v1/purchase/inflowReceipt/create', {
        wsGRN: { vendorInvoiceNumber: form.vendorInvoiceNumber || `INV-${reqId}`, vendorInvoiceDate: form.vendorInvoiceDate || nowIsoUtc(), currencyCode: CFG.currency },
        purchaseOrderCode: poCode, vendorInvoiceDateCheckDisable: true,
      })).inflowReceiptCode);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await memoStep(reqId, `GRNITEM_${i}`, async () => {
        await uc.public('/services/rest/v1/purchase/inflowReceipt/addItemSKU', {
          inflowReceiptCode: grnCode, inflowReceiptItem: { quantity: Number(it.quantity), unitPrice: Number(it.unitPrice), skuCode: it.sku },
        });
        return 'ok';
      });
    }

    await memoStep(reqId, 'SENDQC', async () => { await uc.data('/data/inflow/po/receive/sendForQC', { inflowReceiptCode: grnCode }, fac); return 'ok'; });

    const grnItems = await memoStep(reqId, 'GRNFETCH', async () => {
      const r = await uc.public('/services/rest/v1/purchase/inflowReceipt/getInflowReceipt', { inflowReceiptCode: grnCode });
      return (r.inflowReceipt.inflowReceiptItems || []).map((x) => ({ id: x.id, quantity: x.quantity, inventoryType: x.inventoryType || 'GOOD_INVENTORY' }));
    });

    await memoStep(reqId, 'QCDONE', async () => { await uc.data('/data/inflow/qc/complete', { inflowReceiptCode: grnCode, inflowReceiptItemIds: grnItems.map((x) => x.id) }, fac); return 'ok'; });

    const ptCode = await memoStep(reqId, 'PTCREATE', async () =>
      (await uc.data('/data/putaway/create', { type: 'PUTAWAY_GRN_ITEM' }, fac)).putawayDTO.code);

    await memoStep(reqId, 'PTADD', async () => {
      await uc.data('/data/putaway/manager/add/inflowReceiptItems', {
        putawayCode: ptCode, inflowReceiptCode: grnCode,
        inflowReceiptItemList: grnItems.map((x) => ({ inflowReceiptItemId: x.id, inventoryType: x.inventoryType, quantity: x.quantity, qcRejectedQuantity: 0 })),
      }, fac);
      return 'ok';
    });
    await memoStep(reqId, 'PTLIST', async () => { await uc.data('/data/putaway/manager/createPutawayList', { putawayCode: ptCode }, fac); return 'ok'; });
    await memoStep(reqId, 'PTCOMPLETE', async () => { await uc.data('/data/putaway/complete', { putawayCode: ptCode }, fac); return 'ok'; });

    const inventory = await snapshot(items.map((it) => it.sku));
    return { reqId, mode: 'GRN_PUTAWAY', poCode, grnCode, putawayCode: ptCode, inventory, status: 'INWARD_DONE' };
  }

  async function runInward(form) {
    return CFG.inwardMode === 'GRN_PUTAWAY' ? inwardPutaway(form) : inwardAdjust(form);
  }

  /* ------------------------------- OUTWARD ------------------------------- */

  async function runOutward(form) {
    const { reqId, items } = form;
    const orderCode = (form.orderCode && String(form.orderCode).trim()) || `OUT-${reqId.slice(0, 8).toUpperCase()}`;

    const soCode = await memoStep(reqId, 'SO', async () => {
      const addr = {
        id: 'a1', name: form.customerName || 'B2B Customer', addressLine1: form.addressLine1 || 'NA',
        city: form.city || 'NA', state: form.state || 'NA', country: form.country || 'India',
        pincode: String(form.pincode || '000000'), phone: String(form.phone || '0000000000'), email: form.email || '',
      };
      // Unicommerce uses ONE order item per unit (WsSaleOrderItem.quantity is ignored).
      const soItems = [];
      items.forEach((it, i) => {
        const price = Number(it.sellingPrice != null ? it.sellingPrice : it.unitPrice) || 0;
        const qty = Math.max(1, Number(it.quantity) || 1);
        for (let u = 0; u < qty; u++) {
          soItems.push({ code: `${orderCode}-${i + 1}-${u + 1}`, itemSku: it.sku, sellingPrice: price, totalPrice: price, shippingMethodCode: CFG.outwardShipMethod, facilityCode: CFG.facility });
        }
      });
      const saleOrder = {
        code: orderCode, displayOrderCode: orderCode, channel: CFG.outwardChannel, cashOnDelivery: false, currencyCode: CFG.currency,
        addresses: [addr], billingAddress: { referenceId: 'a1' }, shippingAddress: { referenceId: 'a1' }, saleOrderItems: soItems,
      };
      if (form.customerCode) saleOrder.customerCode = form.customerCode;
      await uc.public('/services/rest/v1/oms/saleOrder/create', { saleOrder }, fac);
      return orderCode;
    });

    const pkgs = await memoStep(reqId, 'ALLOCATE', async () => {
      const alloc = {};
      items.forEach((it) => { const q = Math.max(1, Number(it.quantity) || 1); alloc[it.sku] = { inventory: (alloc[it.sku]?.inventory || 0) + q }; });
      const r = await uc.data('/data/oms/saleorder/allocate/inventory', { saleOrderCode: soCode, saleOrderItemCodeToInventoryAllocation: alloc }, fac);
      const warn = (r.warnings || []).map((w) => w.message).filter(Boolean);
      if (warn.length && !(r.shippingPackageCodes || []).length) {
        throw new Error(`allocate: ${warn.join('; ')} — check shipping serviceability / provider for ${CFG.outwardShipMethod}`);
      }
      return r.shippingPackageCodes || [];
    });

    const invoices = await memoStep(reqId, 'INVOICE', async () => {
      const out = [];
      for (const pkg of pkgs || []) {
        const r = await uc.public('/services/rest/v1/oms/shippingPackage/createInvoice', { shippingPackageCode: pkg }, fac);
        out.push({ pkg, invoiceCode: r.invoiceDisplayCode || r.invoiceCode || '' });
      }
      return out;
    });

    const inventory = await snapshot(items.map((it) => it.sku));
    return { reqId, op: 'OUTWARD', soCode, shippingPackages: pkgs || [], invoices: invoices || [], inventory, status: 'OUTWARD_DONE' };
  }

  /* ------------------------------ FULL CYCLE ----------------------------- */

  async function runFullCycle(form) {
    const baseReq = form.reqId;
    const inForm = {
      reqId: `${baseReq}:in`, vendorInvoiceNumber: form.vendorInvoiceNumber, vendorInvoiceDate: form.vendorInvoiceDate,
      items: (form.items || []).map((it) => ({ sku: it.sku, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice != null ? it.unitPrice : 0), maxRetailPrice: it.maxRetailPrice ? Number(it.maxRetailPrice) : undefined, taxCode: it.taxCode })),
    };
    let inward;
    try { inward = await runInward(inForm); }
    catch (e) { throw new Error(`Inward failed — outward NOT attempted: ${e.message || e}`); }

    const outForm = {
      reqId: `${baseReq}:out`, orderCode: form.orderCode, customerCode: form.customerCode, customerName: form.customerName,
      phone: form.phone, email: form.email, addressLine1: form.addressLine1, city: form.city, state: form.state, pincode: form.pincode, country: form.country,
      items: (form.items || []).map((it) => ({ sku: it.sku, quantity: Number(it.quantity), sellingPrice: Number(it.sellingPrice != null ? it.sellingPrice : it.unitPrice) || 0 })),
    };
    let outward = null, outwardError = null;
    try { outward = await runOutward(outForm); }
    catch (e) { outwardError = String(e.message || e); }

    return { reqId: baseReq, op: 'FULLCYCLE', status: outward ? 'FULLCYCLE_DONE' : 'OUTWARD_FAILED', inward, outward, outwardError };
  }

  return { runInward, runOutward, runFullCycle };
}
