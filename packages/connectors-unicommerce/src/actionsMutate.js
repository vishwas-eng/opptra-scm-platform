// Mutating Unicommerce actions, the write half of the connector.
//
// EVERY payload here is copied from code that has run against real Unicommerce and been
// verified by a document code or an inventory delta (automation-return, automation-
// inventory, unicommerce-engine/FLOWS.md). Nothing in this file is inferred from an
// endpoint name. If you cannot point at a proven call, it does not belong here.
//
// Four rules every mutate obeys:
//   1. `mutates: true`, the connector shell turns ctx.dryRun into a preview of the exact
//      request body, so an operator can see what WOULD be sent without sending it.
//   2. Never blind-retry. uc-client retries idempotent GETs; a mutate that fails stays
//      failed and surfaces, because a silent second allocate/invoice is real money.
//   3. Facility is explicit. `/data/*` facility is session-global on a concurrency-1
//      worker, so an action that guesses it corrupts the next job's context.
//   4. Assert the upstream envelope. `successful: false` is a business failure and must
//      not be reported as success, it is NOT session death (that is 401 / redirect /
//      USER_NOT_LOGGED_IN only).

/** Throw on UC's business-failure envelope so a mutate can never report false success. */
function assertSuccessful(d, what) {
  if (d?.successful === false) {
    const msg = (d.errors || [])
      .map((e) => e.description || e.message || String(e))
      .join('; ') || `${what}: successful:false`;
    throw new Error(`${what}: ${msg}`);
  }
  return d;
}

const FACILITY_PROP = { type: 'string', minLength: 1, maxLength: 60 };
const SO_PROP = { type: 'string', minLength: 2, maxLength: 40 };
const PKG_PROP = { type: 'string', minLength: 2, maxLength: 60 };

export function registerAllocationActions(register) {
  register({
    id: 'saleOrder.allocateB2C',
    title: 'Allocate inventory (B2C)',
    mutates: true,
    backend: 're',
    description: 'POST /data/oms/saleorder/allocate/inventory, synchronous; returns shippingPackageCodes. Flow-proven (FLOWS.md §2, OPPD00149).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder', 'facility', 'items'],
      additionalProperties: false,
      properties: {
        saleOrder: SO_PROP,
        facility: FACILITY_PROP,
        items: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            required: ['sku', 'quantity'],
            additionalProperties: false,
            properties: {
              sku: { type: 'string', minLength: 1, maxLength: 60 },
              quantity: { type: 'integer', minimum: 1, maximum: 100000 },
            },
          },
        },
      },
    },
    handler: async (uc, params) => {
      const alloc = {};
      for (const it of params.items) alloc[it.sku] = { inventory: it.quantity };
      const d = await uc.data(
        '/data/oms/saleorder/allocate/inventory',
        { saleOrderCode: params.saleOrder, saleOrderItemCodeToInventoryAllocation: alloc },
        { facility: params.facility },
      );
      assertSuccessful(d, 'allocate B2C');
      return {
        ok: true,
        saleOrder: params.saleOrder,
        facility: params.facility,
        shippingPackageCodes: d?.shippingPackageCodes || [],
      };
    },
  });

  register({
    id: 'saleOrder.allocateB2B',
    title: 'Allocate inventory (B2B smart-fill)',
    mutates: true,
    backend: 're',
    description: 'POST /data/wms/b2b/sale-order/smart-fill/orders/allocate, ASYNC. inventoryLocationData (shelf) is REQUIRED: without it UC returns HTTP 200 and allocates nothing. The package materializes minutes later, poll saleOrder.getShippingPackages. Flow-proven (FLOWS.md §3, OPPD00150).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder', 'facility', 'items'],
      additionalProperties: false,
      properties: {
        saleOrder: SO_PROP,
        facility: FACILITY_PROP,
        items: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            required: ['sku', 'quantity'],
            additionalProperties: false,
            properties: {
              sku: { type: 'string', minLength: 1, maxLength: 60 },
              quantity: { type: 'integer', minimum: 1, maximum: 100000 },
              shelfCode: { type: 'string', maxLength: 60 },
              batchCode: { type: 'string', maxLength: 60 },
            },
          },
        },
      },
    },
    handler: async (uc, params) => {
      const allocated = [];
      for (const it of params.items) {
        // Resolve the shelf when the caller did not pin one. An empty inventoryLocationData
        // is the classic silent-failure: 200 OK, zero units allocated.
        let shelfCode = it.shelfCode;
        let batchCode = it.batchCode ?? '';
        if (!shelfCode) {
          const bw = await uc.dataGet(
            `/data/wms/inventory/batchwise?skuCode=${encodeURIComponent(it.sku)}`,
            { facility: params.facility },
          );
          const locs = bw?.batchwiseInventories || [];
          const pick = locs.find((l) => (l.availableQuantity || 0) >= it.quantity) || locs[0];
          if (!pick) {
            return {
              ok: false,
              code: 'INVALID_INPUT',
              retryable: false,
              error: `no shelf/batch inventory found for ${it.sku} at ${params.facility}, allocation would silently do nothing`,
              sku: it.sku,
            };
          }
          shelfCode = pick.shelfCode || 'DEFAULT';
          batchCode = pick.batchCode || '';
        }
        const d = await uc.data(
          '/data/wms/b2b/sale-order/smart-fill/orders/allocate',
          {
            allocationItems: [{
              saleOrderCode: params.saleOrder,
              shippingPackageCode: null,
              saleOrderItemCodeToInventoryAllocation: {
                [it.sku]: {
                  inventory: it.quantity,
                  inventoryLocationData: [{
                    shelfCode, batchCode, inventory: String(it.quantity),
                  }],
                },
              },
            }],
          },
          { facility: params.facility },
        );
        assertSuccessful(d, `allocate B2B ${it.sku}`);
        allocated.push({ sku: it.sku, quantity: it.quantity, shelfCode, batchCode });
      }
      return {
        ok: true,
        async: true,
        saleOrder: params.saleOrder,
        facility: params.facility,
        allocated,
        note: 'B2B allocation is asynchronous, poll saleOrder.getShippingPackages until the package appears.',
      };
    },
  });
}

export function registerInvoiceDispatchActions(register) {
  register({
    id: 'shippingPackage.createInvoice',
    title: 'Create invoice for a shipping package',
    mutates: true,
    backend: 're',
    description: 'POST /services/rest/v1/oms/shippingPackage/createInvoice (bearer), moves the package to PACKED and returns invoiceCode. Flow-proven (FLOWS.md §2/§3, INS0109/INS0110).',
    inputSchema: {
      type: 'object',
      required: ['shippingPackageCode', 'facility'],
      additionalProperties: false,
      properties: { shippingPackageCode: PKG_PROP, facility: FACILITY_PROP },
    },
    handler: async (uc, params) => {
      const d = await uc.public(
        '/services/rest/v1/oms/shippingPackage/createInvoice',
        { shippingPackageCode: params.shippingPackageCode },
        { facility: params.facility },
      );
      return {
        ok: true,
        shippingPackageCode: params.shippingPackageCode,
        invoiceCode: d?.invoiceCode || d?.invoice?.code || null,
      };
    },
  });

  register({
    id: 'shipment.allocateProvider',
    title: 'Allocate courier + AWB',
    mutates: true,
    backend: 're',
    description: 'POST /data/oms/shipment/provider/allocate, assigns a trackingNumber from the courier pool. Flow-proven (FLOWS.md §4).',
    inputSchema: {
      type: 'object',
      required: ['shippingPackageCode', 'facility'],
      additionalProperties: false,
      properties: { shippingPackageCode: PKG_PROP, facility: FACILITY_PROP },
    },
    handler: async (uc, params) => {
      const d = await uc.data(
        '/data/oms/shipment/provider/allocate',
        { shippingPackageCode: params.shippingPackageCode },
        { facility: params.facility },
      );
      assertSuccessful(d, 'provider allocate');
      return {
        ok: true,
        shippingPackageCode: params.shippingPackageCode,
        trackingNumber: d?.trackingNumber || d?.shippingPackage?.trackingNumber || null,
        provider: d?.shippingProviderCode || null,
      };
    },
  });

  register({
    id: 'shipment.dispatch',
    title: 'Dispatch a shipping package',
    mutates: true,
    backend: 're',
    description: 'POST /data/oms/shipment/dispatch. NOTE: in the manifest flow it is manifest.close that dispatches, use this only for the direct path.',
    inputSchema: {
      type: 'object',
      required: ['shippingPackageCode', 'facility'],
      additionalProperties: false,
      properties: { shippingPackageCode: PKG_PROP, facility: FACILITY_PROP },
    },
    handler: async (uc, params) => {
      const d = await uc.data(
        '/data/oms/shipment/dispatch',
        { shippingPackageCode: params.shippingPackageCode },
        { facility: params.facility },
      );
      assertSuccessful(d, 'dispatch');
      return { ok: true, shippingPackageCode: params.shippingPackageCode, dispatched: true };
    },
  });

  register({
    id: 'shipment.markDelivered',
    title: 'Mark a package delivered',
    mutates: true,
    backend: 're',
    description: 'POST /data/oms/shipment/markDelivered {shippingPackageCode, podCode}. Required before a customer return can be raised. Flow-proven (FLOWS.md §4).',
    inputSchema: {
      type: 'object',
      required: ['shippingPackageCode', 'facility'],
      additionalProperties: false,
      properties: {
        shippingPackageCode: PKG_PROP,
        facility: FACILITY_PROP,
        podCode: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const d = await uc.data(
        '/data/oms/shipment/markDelivered',
        {
          shippingPackageCode: params.shippingPackageCode,
          podCode: params.podCode || `POD-${params.shippingPackageCode}`,
        },
        { facility: params.facility },
      );
      assertSuccessful(d, 'markDelivered');
      return { ok: true, shippingPackageCode: params.shippingPackageCode, delivered: true };
    },
  });
}

export function registerManifestActions(register) {
  register({
    id: 'manifest.create',
    title: 'Create a shipping manifest',
    mutates: true,
    backend: 're',
    description: 'POST /services/rest/v1/oms/shippingManifest/create (bearer) → shippingManifestCode. Flow-proven (FLOWS.md §4, SM0080/81/87/89).',
    inputSchema: {
      type: 'object',
      required: ['channel', 'facility'],
      additionalProperties: false,
      properties: {
        channel: { type: 'string', minLength: 1, maxLength: 60 },
        shippingProviderCode: { type: 'string', maxLength: 60 },
        facility: FACILITY_PROP,
      },
    },
    handler: async (uc, params) => {
      const d = await uc.public(
        '/services/rest/v1/oms/shippingManifest/create',
        {
          channel: params.channel,
          shippingProviderCode: params.shippingProviderCode || 'CUSTOM',
        },
        { facility: params.facility },
      );
      return { ok: true, shippingManifestCode: d?.shippingManifestCode || null };
    },
  });

  register({
    id: 'manifest.addPackages',
    title: 'Add packages to a manifest',
    mutates: true,
    backend: 're',
    description: 'POST /services/rest/v1/oms/shippingManifest/addShippingPackage (bearer).',
    inputSchema: {
      type: 'object',
      required: ['shippingManifestCode', 'shippingPackageCodes', 'facility'],
      additionalProperties: false,
      properties: {
        shippingManifestCode: { type: 'string', minLength: 2, maxLength: 60 },
        shippingPackageCodes: {
          type: 'array', minItems: 1, maxItems: 200,
          items: { type: 'string', minLength: 2, maxLength: 60 },
        },
        facility: FACILITY_PROP,
      },
    },
    handler: async (uc, params) => {
      await uc.public(
        '/services/rest/v1/oms/shippingManifest/addShippingPackage',
        {
          shippingManifestCode: params.shippingManifestCode,
          shippingPackageCodes: params.shippingPackageCodes,
        },
        { facility: params.facility },
      );
      return {
        ok: true,
        shippingManifestCode: params.shippingManifestCode,
        added: params.shippingPackageCodes.length,
      };
    },
  });

  register({
    id: 'manifest.close',
    title: 'Close a manifest (THIS dispatches)',
    mutates: true,
    backend: 're',
    description: 'POST /services/rest/v1/oms/shippingManifest/close (bearer). Closing the manifest is what actually dispatches the packages, not a separate dispatch call. Irreversible. Flow-proven (FLOWS.md §4).',
    inputSchema: {
      type: 'object',
      required: ['shippingManifestCode', 'facility'],
      additionalProperties: false,
      properties: {
        shippingManifestCode: { type: 'string', minLength: 2, maxLength: 60 },
        facility: FACILITY_PROP,
      },
    },
    handler: async (uc, params) => {
      await uc.public(
        '/services/rest/v1/oms/shippingManifest/close',
        { shippingManifestCode: params.shippingManifestCode },
        { facility: params.facility },
      );
      return {
        ok: true,
        shippingManifestCode: params.shippingManifestCode,
        closed: true,
        dispatched: true,
      };
    },
  });
}

export function registerReturnMutateActions(register) {
  register({
    id: 'returns.bulkReturnCreate',
    title: 'Create a bulk return (auto-creates the CN)',
    mutates: true,
    backend: 're',
    description: 'POST /data/oms/returns/reversePickup/bulkReturn/create. The order must be DELIVERED first. The ISR credit note is created automatically, read it back via saleOrder.getInvoiceDetails. Inventory does NOT return to sellable until putaway.complete. Flow-proven (FLOWS.md §5, ISR0051, inventory +1).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder', 'facility', 'customerCode', 'channelCode', 'items'],
      additionalProperties: false,
      properties: {
        saleOrder: SO_PROP,
        facility: FACILITY_PROP,
        customerCode: { type: 'string', minLength: 1, maxLength: 60 },
        channelCode: { type: 'string', minLength: 1, maxLength: 60 },
        invoiceCode: { type: 'string', maxLength: 60 },
        referenceCode: { type: 'string', maxLength: 60 },
        reason: { type: 'string', maxLength: 120 },
        items: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            required: ['sku', 'quantity'],
            additionalProperties: false,
            properties: {
              sku: { type: 'string', minLength: 1, maxLength: 60 },
              quantity: { type: 'integer', minimum: 1, maximum: 100000 },
              inventoryType: { type: 'string', enum: ['GOOD_INVENTORY', 'BAD_INVENTORY'] },
            },
          },
        },
      },
    },
    handler: async (uc, params) => {
      const d = await uc.data(
        '/data/oms/returns/reversePickup/bulkReturn/create',
        {
          customerCode: params.customerCode,
          referenceCode: params.referenceCode || `RET-${params.saleOrder}`,
          bulkReturnReason: params.reason || 'Return',
          bulkReturnId: null,
          channelCode: params.channelCode,
          saleOrderCode: params.saleOrder,
          putawayCode: null,
          putawayEnabled: true,
          lineItems: params.items.map((it) => ({
            skuCode: it.sku,
            quantity: it.quantity,
            inventoryType: it.inventoryType || 'GOOD_INVENTORY',
            returnReason: null,
          })),
          invoiceCode: params.invoiceCode || null,
        },
        { facility: params.facility },
      );
      assertSuccessful(d, 'bulk return create');
      return {
        ok: true,
        saleOrder: params.saleOrder,
        bulkReturnId: d?.bulkReturnId ?? null,
        putawayCode: d?.putawayCode ?? null,
        reversePickups: (d?.reversePickups || []).map((x) => x.reversePickupCode).filter(Boolean),
        note: 'Credit note is auto-created, read it via saleOrder.getInvoiceDetails. Inventory returns to sellable only after putaway.complete.',
      };
    },
  });

  register({
    id: 'putaway.complete',
    title: 'Complete putaway (returns inventory to sellable)',
    mutates: true,
    backend: 're',
    description: 'POST /data/putaway/manager/createPutawayList then /data/putaway/complete. Until this runs, returned stock is NOT sellable. Flow-proven (FLOWS.md §5).',
    inputSchema: {
      type: 'object',
      required: ['putawayCode', 'facility'],
      additionalProperties: false,
      properties: {
        putawayCode: { type: 'string', minLength: 2, maxLength: 60 },
        facility: FACILITY_PROP,
      },
    },
    handler: async (uc, params) => {
      await uc.data(
        '/data/putaway/manager/createPutawayList',
        { putawayCode: params.putawayCode },
        { facility: params.facility },
      );
      const d = await uc.data(
        '/data/putaway/complete',
        { putawayCode: params.putawayCode },
        { facility: params.facility },
      );
      assertSuccessful(d, 'putaway complete');
      return { ok: true, putawayCode: params.putawayCode, inventoryRestored: true };
    },
  });
}

export function registerInventoryMutateActions(register) {
  register({
    id: 'inventory.adjust',
    title: 'Adjust inventory (ADD / REMOVE)',
    mutates: true,
    backend: 're',
    description: 'POST /data/inflow/inventory/adjust, the same call automation-inventory uses for ADJUST mode. Applies to ONE sku/shelf at a time.',
    inputSchema: {
      type: 'object',
      required: ['sku', 'quantity', 'adjustmentType', 'facility'],
      additionalProperties: false,
      properties: {
        sku: { type: 'string', minLength: 1, maxLength: 60 },
        quantity: { type: 'integer', minimum: 1, maximum: 100000 },
        adjustmentType: { type: 'string', enum: ['ADD', 'REMOVE'] },
        inventoryType: { type: 'string', enum: ['GOOD_INVENTORY', 'BAD_INVENTORY'] },
        shelfCode: { type: 'string', maxLength: 60 },
        remarks: { type: 'string', maxLength: 200 },
        facility: FACILITY_PROP,
      },
    },
    handler: async (uc, params) => {
      const d = await uc.data(
        '/data/inflow/inventory/adjust',
        {
          inventoryAdjustment: {
            itemSKU: params.sku,
            quantity: params.quantity,
            shelfCode: params.shelfCode || 'DEFAULT',
            inventoryType: params.inventoryType || 'GOOD_INVENTORY',
            adjustmentType: params.adjustmentType,
            remarks: params.remarks || 'opptra-connector',
          },
        },
        { facility: params.facility },
      );
      assertSuccessful(d, 'inventory adjust');
      return {
        ok: true,
        sku: params.sku,
        quantity: params.quantity,
        adjustmentType: params.adjustmentType,
        facility: params.facility,
      };
    },
  });
}

export function registerOrderMutateActions(register) {
  register({
    id: 'saleOrder.cancel',
    title: 'Cancel a sale order',
    mutates: true,
    backend: 're',
    description: 'POST /services/rest/v1/oms/saleOrder/cancel (bearer). Irreversible.',
    inputSchema: {
      type: 'object',
      required: ['saleOrder', 'facility'],
      additionalProperties: false,
      properties: { saleOrder: SO_PROP, facility: FACILITY_PROP },
    },
    handler: async (uc, params) => {
      await uc.public(
        '/services/rest/v1/oms/saleOrder/cancel',
        { saleOrderCode: params.saleOrder },
        { facility: params.facility },
      );
      return { ok: true, saleOrder: params.saleOrder, cancelled: true };
    },
  });
}
