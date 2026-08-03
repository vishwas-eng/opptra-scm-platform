import { makeUcOrderLookup } from '@opptra/uc-client';

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
}
