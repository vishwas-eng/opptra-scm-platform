// Home Centre → Unicommerce B2C SO punch (customer create + saleOrder/create ONLY).
// No UC allocate / invoice / dispatch — that stays out of scope per product decision.
//
// Vinculum fulfill (confirm/ship/label) is separate via makeVinculumFulfill.

import { makeVinculumClient, makeVinculumFulfill } from '@opptra/integrations-vinculum';

function parseSkuMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function soCodeFor(webOrderNo) {
  const base = String(webOrderNo || '').trim();
  return base.startsWith('HC-') ? base : `HC-${base}`;
}

function customerCodeFor(order) {
  const phone = String(order.phone || order.buyerPhone || '').replace(/\D/g, '').slice(-10);
  const seed = phone || String(order.webOrderNo || '').replace(/\W/g, '').slice(0, 12);
  return `HC-${seed || 'GUEST'}`.slice(0, 40);
}

export function makeHomecentrePipeline(uc, cfg, vinculumClient) {
  const channel = cfg.HC_UC_CHANNEL || cfg.UC_OUTWARD_CHANNEL || 'CUSTOM';
  const shipMethod = cfg.HC_UC_SHIP_METHOD || cfg.UC_OUTWARD_SHIP_METHOD || 'STD';
  const currency = cfg.HC_UC_CURRENCY || cfg.UC_CURRENCY || 'AED';
  const facility = cfg.HC_UC_FACILITY || cfg.UC_DEFAULT_FACILITY || '';
  const fac = facility ? { facility } : {};
  const skuMap = parseSkuMap(cfg.HC_SKU_MAP_JSON);
  const vin = vinculumClient || makeVinculumClient({
    baseUrl: cfg.VINCULUM_BASE_URL,
    userName: cfg.VINCULUM_USER,
    password: cfg.VINCULUM_PASS,
  });
  const fulfill = makeVinculumFulfill(vin, { fulfillActionsJson: cfg.VINCULUM_FULFILL_ACTIONS_JSON });

  function mapSku(hcSku) {
    if (!hcSku) throw new Error('HC SKU missing on order row');
    if (skuMap[hcSku]) return skuMap[hcSku];
    // Identity fallback — works when UC catalog already uses Landmark SKUs
    return hcSku;
  }

  async function createCustomer(order) {
    const code = order.customerCode || customerCodeFor(order);
    const name = order.customerName || order.buyerName || `HC ${order.webOrderNo}`;
    const addressLine1 = order.addressLine1 || order.buyerAddress || 'NA';
    const city = order.city || 'Dubai';
    const state = order.state || 'DU';
    const country = order.country || 'AE';
    const pincode = String(order.pincode || order.zip || '00000');
    const phone = String(order.phone || order.buyerPhone || '0000000000');
    const email = order.email || order.customerEmail || '';

    const body = {
      customerCode: code,
      name,
      enabled: true,
      customerAddress: {
        addressLine1,
        city,
        stateCode: state,
        countryCode: country.length === 2 ? country : 'AE',
        pincode,
        phone,
        email,
      },
    };

    // Prefer oms path (proven in staging notes); fall back to catalog path.
    try {
      await uc.public('/services/rest/v1/oms/customer/create', body, fac);
    } catch (err) {
      const msg = String(err.message || err);
      if (/already|exist|duplicate/i.test(msg)) return { customerCode: code, existed: true };
      try {
        await uc.public('/services/rest/v1/customer/create', {
          WsCustomer: {
            code,
            name,
            enabled: true,
            partyAddress: {
              addressLine1, city, stateCode: state,
              countryCode: country.length === 2 ? country : 'AE',
              pincode, phone, email,
            },
          },
        }, fac);
      } catch (err2) {
        const m2 = String(err2.message || err2);
        if (/already|exist|duplicate/i.test(m2)) return { customerCode: code, existed: true };
        throw err2;
      }
    }
    return { customerCode: code, existed: false };
  }

  async function createB2cSaleOrder(order, customerCode) {
    const orderCode = soCodeFor(order.webOrderNo);
    const ucSku = mapSku(order.hcSku);
    const price = Number(order.price || order.lineAmount || 0) || 0;
    const qty = Math.max(1, Number(order.qty) || 1);
    const addr = {
      id: 'a1',
      name: order.customerName || order.buyerName || 'Home Centre Buyer',
      addressLine1: order.addressLine1 || order.buyerAddress || 'NA',
      city: order.city || 'Dubai',
      state: order.state || 'DU',
      country: order.country || 'United Arab Emirates',
      pincode: String(order.pincode || order.zip || '00000'),
      phone: String(order.phone || order.buyerPhone || '0000000000'),
      email: order.email || order.customerEmail || '',
    };
    const saleOrderItems = [];
    for (let u = 0; u < qty; u++) {
      saleOrderItems.push({
        code: `${orderCode}-${u + 1}`,
        itemSku: ucSku,
        sellingPrice: price,
        totalPrice: price,
        shippingMethodCode: shipMethod,
        facilityCode: facility || undefined,
      });
    }
    const saleOrder = {
      code: orderCode,
      displayOrderCode: orderCode,
      channel,
      cashOnDelivery: !!order.cashOnDelivery,
      currencyCode: currency,
      customerCode,
      addresses: [addr],
      billingAddress: { referenceId: 'a1' },
      shippingAddress: { referenceId: 'a1' },
      saleOrderItems,
    };
    await uc.public('/services/rest/v1/oms/saleOrder/create', { saleOrder }, fac);
    return { soCode: orderCode, ucSku, qty, price };
  }

  /** Enrich Vinculum list row with optional buyer fields from export/input. */
  function mergeBuyer(order, extra = {}) {
    return { ...order, ...extra };
  }

  async function punchOne(order, { dryRun = false } = {}) {
    const webOrderNo = order.webOrderNo;
    if (!webOrderNo) return { ok: false, error: 'missing webOrderNo' };
    const soCode = soCodeFor(webOrderNo);
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        webOrderNo,
        soCode,
        hcSku: order.hcSku,
        ucSku: mapSku(order.hcSku),
        price: order.price,
        qty: order.qty,
        channel: order.channel || channel,
      };
    }
    try {
      // Soft idempotency: probe existing SO via public get (POST body)
      try {
        const existing = await uc.public(
          '/services/rest/v1/oms/saleOrder/get',
          { saleOrderCode: soCode },
          { ...fac, idempotent: true },
        );
        if (existing?.saleOrderDTO || existing?.saleOrder || existing?.code || existing?.successful) {
          return { ok: true, webOrderNo, soCode, skipped: true, reason: 'so_already_exists' };
        }
      } catch { /* not found → create */ }

      const cust = await createCustomer(order);
      const so = await createB2cSaleOrder(order, cust.customerCode);
      return { ok: true, webOrderNo, ...so, customerCode: cust.customerCode, customerExisted: cust.existed };
    } catch (err) {
      const msg = String(err.message || err);
      if (/already|duplicate|exist/i.test(msg)) {
        return { ok: true, webOrderNo, soCode, skipped: true, reason: msg };
      }
      return { ok: false, webOrderNo, soCode, error: msg };
    }
  }

  async function syncOrders({ dryRun = false, limit = 50, source = 'active', buyerByOrder = {} } = {}) {
    // Empty Home Centre is a normal success — never treat "0 orders" as failure.
    let page;
    try {
      page = source === 'archive'
        ? await vin.listArchiveOrders({ rows: Math.min(200, Math.max(limit, 50)) })
        : await vin.listActiveOrders({ rows: Math.min(200, Math.max(limit, 50)) });
    } catch (err) {
      return {
        ok: false,
        dryRun: !!dryRun,
        source,
        fetched: 0,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        error: String(err.message || err),
        message: 'Could not list Home Centre orders (check Vinculum login)',
      };
    }
    const orders = (page.orders || []).slice(0, limit).map((o) => mergeBuyer(o, buyerByOrder[o.webOrderNo] || {}));
    if (!orders.length) {
      return {
        ok: true,
        dryRun: !!dryRun,
        source,
        fetched: page.records ?? 0,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        empty: true,
        message: 'No Home Centre orders to process — nothing to do',
      };
    }
    const results = [];
    for (const order of orders) {
      results.push(await punchOne(order, { dryRun }));
    }
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    return {
      ok: failed === 0,
      dryRun: !!dryRun,
      source,
      fetched: page.records,
      processed: results.length,
      okCount,
      failed,
      results,
      message: failed ? `${failed} order(s) failed` : `Processed ${okCount} order(s)`,
    };
  }

  async function fulfillOrders({ dryRun = false, limit = 20, webOrderNos = null } = {}) {
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        message: 'Fulfill dry-run OK (no orders required). Live confirm/ship/label needs VINCULUM_FULFILL_ACTIONS_JSON after HAR capture.',
        actionsConfigured: fulfill.actionsConfigured,
      };
    }
    let page;
    try {
      page = await vin.listActiveOrders({ rows: 100 });
    } catch (err) {
      return {
        ok: false,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        error: String(err.message || err),
        message: 'Could not list orders for fulfill',
        actionsConfigured: fulfill.actionsConfigured,
      };
    }
    let orders = page.orders || [];
    if (webOrderNos?.length) {
      const set = new Set(webOrderNos.map(String));
      orders = orders.filter((o) => set.has(o.webOrderNo));
    }
    orders = orders.slice(0, limit);
    if (!orders.length) {
      return {
        ok: true,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        empty: true,
        message: 'No Home Centre orders to fulfill — nothing to do',
        actionsConfigured: fulfill.actionsConfigured,
      };
    }
    const results = [];
    for (const order of orders) {
      results.push(await fulfill.fulfillOrder(order));
    }
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    return {
      ok: failed === 0,
      processed: results.length,
      okCount,
      failed,
      actionsConfigured: fulfill.actionsConfigured,
      results,
      message: failed ? `${failed} fulfill step(s) failed` : `Fulfilled ${okCount} order(s)`,
    };
  }

  async function syncAndFulfill(opts = {}) {
    const punched = await syncOrders(opts);
    const fulfillPart = opts.skipFulfill
      ? { ok: true, skipped: true, message: 'fulfill skipped' }
      : await fulfillOrders({ ...opts, webOrderNos: punched.results.filter((r) => r.ok).map((r) => r.webOrderNo) });
    return { ok: punched.ok && fulfillPart.ok, punch: punched, fulfill: fulfillPart };
  }

  return {
    syncOrders,
    punchOne,
    fulfillOrders,
    syncAndFulfill,
    mapSku,
    soCodeFor,
    vinculum: vin,
  };
}
