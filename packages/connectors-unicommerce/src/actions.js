import { makeUcOrderLookup } from '@opptra/uc-client';

/**
 * When a shape probe finds nothing, report the response's top-level key names instead of
 * echoing the body back. Tenants differ in envelope shape and we need to see that, but a
 * raw body can carry session/PII values into an LLM tool result.
 */
function shapeHint(d) {
  if (!d || typeof d !== 'object') return { responseType: typeof d };
  return { responseKeys: Object.keys(d).slice(0, 25) };
}

/** Read-only auth / health actions. Never return cookie or bearer material. */
export function registerAuthActions(register) {
  register({
    id: 'health.ping',
    title: 'UC session health ping',
    mutates: false,
    backend: 're',
    description: 'Cheap /data/user/facilities probe via existing uc.ping(); reuses session vault + keepalive path.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (uc) => {
      const r = await uc.ping();
      return {
        ok: !!r.alive,
        alive: !!r.alive,
        currentFacility: r.currentFacility || null,
        reason: r.reason || null,
        // Explicitly omit any session/cookie fields even if ping grows later.
      };
    },
  });
}

export function registerFacilityActions(register) {
  register({
    id: 'facilities.list',
    title: 'List facilities',
    mutates: false,
    backend: 're',
    description: 'Live facility list from /data/user/facilities (session).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (uc) => {
      const { all, current } = await uc.listFacilities();
      return { ok: true, facilities: all || [], current: current || null };
    },
  });
}

export function registerOrderActions(register) {
  register({
    id: 'saleOrder.getSummary',
    title: 'Sale order summary',
    mutates: false,
    backend: 're',
    description: 'Facility-agnostic fetchSummary via makeUcOrderLookup.',
    inputSchema: {
      type: 'object',
      required: ['saleOrder'],
      additionalProperties: false,
      properties: {
        saleOrder: { type: 'string', minLength: 2, maxLength: 40 },
      },
    },
    handler: async (uc, params) => {
      const so = String(params.saleOrder || '').trim();
      if (!so) return { ok: false, error: 'saleOrder required', found: false };
      const lookup = makeUcOrderLookup(uc);
      const summary = await lookup.summary(so);
      if (!summary) return { ok: true, found: false, saleOrder: so, summary: null };
      return { ok: true, found: true, saleOrder: summary.so, summary };
    },
  });

  register({
    id: 'saleOrder.get',
    title: 'Sale order resolve (summary + facility)',
    mutates: false,
    backend: 're',
    description: 'Summary + facility hop (fetch) — same path ASN/packing use.',
    inputSchema: {
      type: 'object',
      required: ['saleOrder'],
      additionalProperties: false,
      properties: {
        saleOrder: { type: 'string', minLength: 2, maxLength: 40 },
        preferFacility: { type: 'string', maxLength: 60 },
        needFacility: { type: 'boolean', default: true },
      },
    },
    handler: async (uc, params) => {
      const so = String(params.saleOrder || '').trim();
      if (!so) return { ok: false, error: 'saleOrder required', found: false };
      const lookup = makeUcOrderLookup(uc);
      const order = await lookup.resolveOrder(so, {
        prefer: params.preferFacility || null,
        needFacility: params.needFacility !== false,
      });
      if (!order) return { ok: true, found: false, saleOrder: so, order: null };
      return { ok: true, found: true, saleOrder: order.so, order };
    },
  });

  register({
    id: 'saleOrder.getShippingPackages',
    title: 'Sale order shipping packages',
    mutates: false,
    backend: 're',
    description: 'POST /data/oms/saleorder/fetchShippingPackageDetails (facility-scoped).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder'],
      additionalProperties: false,
      properties: {
        saleOrder: { type: 'string', minLength: 2, maxLength: 40 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const so = String(params.saleOrder || '').trim();
      if (!so) return { ok: false, error: 'saleOrder required' };

      let facility = String(params.facility || '').trim();
      if (!facility) {
        const lookup = makeUcOrderLookup(uc);
        facility = await lookup.locateFacility(so);
      }
      if (!facility) {
        return { ok: true, found: false, saleOrder: so, facility: '', shippingPackages: [] };
      }

      const d = await uc.data(
        '/data/oms/saleorder/fetchShippingPackageDetails',
        { saleOrderCode: so },
        { facility },
      );
      const packages = d?.shippingPackages || [];
      return {
        ok: true,
        found: packages.length > 0,
        saleOrder: so,
        facility,
        shippingPackages: packages,
        // Without this, a renamed envelope key is indistinguishable from "no packages" —
        // an operator would read that as "not shipped yet".
        ...(d?.shippingPackages ? {} : shapeHint(d)),
      };
    },
  });
}

// Columns exactly as captured in the live HAR body for the shipments datatable —
// the proven request shape (unicommerce-engine endpoints.json, /data/tasks/export/data).
const SHIPMENTS_TAB_COLUMNS = [
  'saleOrderNum', 'displayOrderCode', 'shipment', 'status', 'channel', 'channelName',
  'channelCode', 'invoiceNumber', 'trackingNumber', 'provider', 'providerCode',
  'shippingCourier', 'itemTypeSkus', 'sellerSkus', 'paymentMethod', 'created',
  'shipmentSkuQty', 'dispatchTime', 'actualWeight', 'stateName', 'onHold', 'priority',
  'picklist', 'putawayPending', 'noOfBoxes',
];

const SHIPMENT_STATUSES = [
  'CREATED', 'LOCATION_NOT_SERVICEABLE', 'PICKING', 'PICKED', 'PACKED', 'READY_TO_SHIP',
  'PENDING_CUSTOMIZATION', 'CUSTOMIZATION_COMPLETE', 'DISPATCHED', 'DELIVERED', 'SHIPPED',
  'RETURN_EXPECTED', 'RETURN_ACKNOWLEDGED', 'RETURNED', 'MANIFESTED',
];

export function registerShipmentSearchActions(register) {
  register({
    id: 'shipments.search',
    title: 'Search shipments (datatable)',
    mutates: false,
    backend: 're',
    description: 'POST /data/tasks/export/data name="DATATABLE SHIPMENTS TAB" — the same grid the UC UI shows. Filter by statuses and created-date text range (TODAY, YESTERDAY, LAST_WEEK…).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        statuses: {
          type: 'array', maxItems: 20, items: { type: 'string', enum: SHIPMENT_STATUSES },
        },
        createdRange: { type: 'string', maxLength: 30, description: 'UC textRange, e.g. TODAY / YESTERDAY / LAST_WEEK' },
        start: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const filters = [{ id: 'putawayPendingFilter', checked: 'false' }];
      const statuses = (params.statuses || []).filter((s) => SHIPMENT_STATUSES.includes(s));
      if (statuses.length) filters.push({ id: 'statusFilter', selectedValues: statuses });
      if (params.createdRange) {
        filters.push({ id: 'createdDateRangeFilter', dateRange: { textRange: String(params.createdRange).toUpperCase() } });
      }
      const body = {
        columns: SHIPMENTS_TAB_COLUMNS,
        fetchResultCount: true,
        disableLabelMany: 'false',
        noOfResults: Math.min(Math.max(Number(params.limit) || 50, 1), 200),
        start: Math.max(Number(params.start) || 0, 0),
        name: 'DATATABLE SHIPMENTS TAB',
        filters,
      };
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.data('/data/tasks/export/data', body, opts);
      // Response shape varies per tenant build — pass rows through untouched and let the
      // caller read the fields it needs; count keys are probed defensively.
      const rows = d?.rows || d?.results || d?.data || [];
      const totalCount = d?.resultCount ?? d?.totalCount ?? d?.count ?? null;
      const found = Array.isArray(rows) && rows.length > 0;
      return { ok: true, count: found ? rows.length : 0, totalCount, rows: found ? rows : [], ...(found ? {} : shapeHint(d)) };
    },
  });
}

export function registerChannelActions(register) {
  register({
    id: 'channels.list',
    title: 'List channels',
    mutates: false,
    backend: 're',
    description: 'POST /data/channel/getChannels {} — every sales channel on this tenant.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (uc) => {
      const d = await uc.data('/data/channel/getChannels', {});
      const channels = d?.channels || d?.channelDTOs || d?.elements || [];
      const found = Array.isArray(channels) && channels.length > 0;
      return { ok: true, count: found ? channels.length : 0, channels: found ? channels : [], ...(found ? {} : shapeHint(d)) };
    },
  });
}

export function registerReturnActions(register) {
  register({
    id: 'returns.bulkReturnSummary',
    title: 'Bulk return summary',
    mutates: false,
    backend: 're',
    description: 'POST /data/oms/returns/reversePickup/bulkReturn/fetchSummary — reverse pickups + putaway for one bulk return id (same call Reverse DC uses).',
    inputSchema: {
      type: 'object',
      required: ['bulkReturnId'],
      additionalProperties: false,
      properties: {
        bulkReturnId: { type: ['string', 'integer'] },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.data(
        '/data/oms/returns/reversePickup/bulkReturn/fetchSummary',
        { bulkReturnId: params.bulkReturnId },
        opts,
      );
      // Named fields only. A reverse-pickup summary carries customer name/address/phone,
      // and this result is persisted verbatim into runs.result — do not echo the body.
      return {
        ok: d?.successful !== false,
        bulkReturnId: params.bulkReturnId,
        putawayCode: d?.putawayCode ?? null,
        reversePickups: (d?.reversePickups || []).map((rp) => ({
          reversePickupCode: rp.reversePickupCode,
          statusCode: rp.statusCode ?? rp.status ?? null,
          saleOrderCode: rp.saleOrderCode ?? null,
        })),
        ...(d?.reversePickups ? {} : shapeHint(d)),
      };
    },
  });
}

export function registerInventoryActions(register) {
  register({
    id: 'inventory.snapshot',
    title: 'Inventory snapshot by SKU',
    mutates: false,
    backend: 're',
    description: 'Public REST inventorySnapshot/get (bearer) — same call as automation-inventory.',
    inputSchema: {
      type: 'object',
      required: ['skus'],
      additionalProperties: false,
      properties: {
        skus: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 60 },
        },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const skus = (params.skus || []).map((s) => String(s).trim()).filter(Boolean);
      if (!skus.length) return { ok: false, error: 'skus required', inventory: {} };
      const opts = { idempotent: true };
      if (params.facility) opts.facility = params.facility;
      const snap = await uc.public(
        '/services/rest/v1/inventory/inventorySnapshot/get',
        { itemTypeSKUs: skus },
        opts,
      );
      const inventory = {};
      for (const s of snap.inventorySnapshots || []) {
        if (s.itemTypeSKU != null) inventory[s.itemTypeSKU] = s.inventory;
      }
      return { ok: true, skus, inventory, snapshots: snap.inventorySnapshots || [] };
    },
  });

  register({
    id: 'inventory.batchwise',
    title: 'Batchwise inventory by SKU',
    mutates: false,
    backend: 're',
    description: 'GET /data/wms/inventory/batchwise?skuCode= — shelf + batch level availability (flow-proven; feeds B2B smart-fill allocation).',
    inputSchema: {
      type: 'object',
      required: ['sku'],
      additionalProperties: false,
      properties: {
        sku: { type: 'string', minLength: 1, maxLength: 60 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const sku = String(params.sku || '').trim();
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.dataGet(
        `/data/wms/inventory/batchwise?skuCode=${encodeURIComponent(sku)}`,
        opts,
      );
      const batches = (d?.batchwiseInventories || []).map((b) => ({
        shelfCode: b.shelfCode,
        batchCode: b.batchCode || '',
        availableQuantity: b.availableQuantity,
      }));
      return { ok: true, sku, count: batches.length, batches };
    },
  });
}

export function registerOrderDetailActions(register) {
  register({
    id: 'saleOrder.getInvoiceDetails',
    title: 'Sale order invoice details',
    mutates: false,
    backend: 're',
    description: 'POST /data/oms/saleorder/fetchInvoiceDetails {saleOrderCode} — invoices[] incl. ISR credit notes (HAR-proven; same call Sheet Update + Return use).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder'],
      additionalProperties: false,
      properties: {
        saleOrder: { type: 'string', minLength: 2, maxLength: 40 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const so = String(params.saleOrder || '').trim();
      if (!so) return { ok: false, error: 'saleOrder required' };
      let facility = String(params.facility || '').trim();
      if (!facility) {
        const lookup = makeUcOrderLookup(uc);
        facility = await lookup.locateFacility(so);
      }
      if (!facility) return { ok: true, found: false, saleOrder: so, invoices: [] };
      const d = await uc.data(
        '/data/oms/saleorder/fetchInvoiceDetails',
        { saleOrderCode: so },
        { facility },
      );
      const invoices = d?.invoices || [];
      return {
        ok: true, found: invoices.length > 0, saleOrder: so, facility, invoices,
        ...(d?.invoices ? {} : shapeHint(d)),
      };
    },
  });

  register({
    id: 'saleOrder.getLineItems',
    title: 'Sale order line items',
    mutates: false,
    backend: 're',
    description: 'POST /data/oms/saleorder/fetchLineItems {code} — per-SKU lines (HAR-proven).',
    inputSchema: {
      type: 'object',
      required: ['saleOrder'],
      additionalProperties: false,
      properties: {
        saleOrder: { type: 'string', minLength: 2, maxLength: 40 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const so = String(params.saleOrder || '').trim();
      if (!so) return { ok: false, error: 'saleOrder required' };
      let facility = String(params.facility || '').trim();
      if (!facility) {
        const lookup = makeUcOrderLookup(uc);
        facility = await lookup.locateFacility(so);
      }
      if (!facility) return { ok: true, found: false, saleOrder: so, lineItems: [] };
      const d = await uc.data(
        '/data/oms/saleorder/fetchLineItems',
        { code: so },
        { facility },
      );
      const lineItems = d?.saleOrderItems || d?.lineItems || d?.elements || [];
      return {
        ok: true,
        found: Array.isArray(lineItems) && lineItems.length > 0,
        saleOrder: so,
        facility,
        lineItems: Array.isArray(lineItems) ? lineItems : [],
        ...(Array.isArray(lineItems) && lineItems.length ? {} : shapeHint(d)),
      };
    },
  });
}
