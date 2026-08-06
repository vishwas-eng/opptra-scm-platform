// Home Centre automation:
//   orders:    Vinculum HC → UC STAGING SO (default); UAE only when HC_ORDERS_UC_TARGET=uae + HC_LIVE
//   inventory: Vinculum seller SKU list → UAE UC qty merge → Vinculum upload (only when HC_LIVE)
// No invoice / transporter / acceptance. No new UC customer when HC_CUSTOMER_CODE is set.

import { makeVinculumClient, makeVinculumFulfill } from '@opptra/integrations-vinculum';
import {
  parseSkuMap,
  vinculumCredsFor,
  resolveHcMode,
  ordersUcConfig,
  inventoryUcConfig,
  makeHcUcClient,
  stagingUcConfig,
  uaeUcConfig,
} from './targets.js';
import { mergeSellerInventoryRows, buildInventoryXlsx, validateInventoryFill } from './inventoryFile.js';

function soCodeFor(webOrderNo) {
  const base = String(webOrderNo || '').trim();
  return base.startsWith('HC-') ? base : `HC-${base}`;
}

function availableQty(snap) {
  const total = Number(snap?.inventory ?? snap?.quantity ?? 0) || 0;
  const openSale = Number(snap?.openSale ?? snap?.openSaleQuantity ?? 0) || 0;
  const blocked = Number(snap?.blockedInventory ?? snap?.blockedQuantity ?? 0) || 0;
  const allocated = Number(snap?.allocated ?? snap?.allocatedQuantity ?? 0) || 0;
  // Prefer sellable − reserved; fall back to inventory alone.
  const reserved = openSale || allocated || blocked;
  return Math.max(0, Math.floor(total - reserved));
}

/** Confirm each seller skuCode exists in UC catalog (identity match). */
async function catalogMatchSkus(uc, skus) {
  const missing = [];
  let matched = 0;
  for (const sku of skus) {
    try {
      const r = await uc.public(
        '/services/rest/v1/catalog/itemType/get',
        { skuCode: sku },
        { idempotent: true },
      );
      if (r?.successful === false && !r?.itemType) {
        missing.push(sku);
      } else {
        matched++;
      }
    } catch {
      missing.push(sku);
    }
  }
  const total = skus.length;
  return {
    matched,
    missing,
    total,
    matchRate: total ? matched / total : 0,
  };
}

async function inventorySnapshotBySku(uc, skus, facility) {
  const bySku = {};
  const chunk = 50;
  const fac = facility ? { facility } : {};
  for (let i = 0; i < skus.length; i += chunk) {
    const batch = skus.slice(i, i + chunk);
    try {
      const snap = await uc.public(
        '/services/rest/v1/inventory/inventorySnapshot/get',
        { itemTypeSKUs: batch },
        { ...fac, idempotent: true },
      );
      for (const s of snap.inventorySnapshots || []) {
        bySku[s.itemTypeSKU] = s;
      }
    } catch (err) {
      // UC returns successful:false "Could not find any any items" when none of the batch exist at facility.
      if (!/Could not find any/i.test(String(err.message || err))) throw err;
    }
  }
  return bySku;
}

export function makeHomecentrePipeline(ucFallback, cfg, vinculumClient) {
  const ownerEmail = cfg.HC_OWNER_EMAIL || 'ratikanta@opptra.com';
  const skuMap = parseSkuMap(cfg.HC_SKU_MAP_JSON);
  const sellerCodeUae = cfg.HC_SELLER_CODE_UAE || '';
  // No '90' default here any more: 90 is the UAE seller code, and stamping it on a KSA
  // upload would file our stock under the wrong seller. Empty falls back to the code
  // on the downloaded SKU row, which is always correct for whichever account is used.
  const sellerCodeOther = cfg.HC_SELLER_CODE_KSA || cfg.HC_SELLER_CODE_OTHER || '';
  const vendorCode = cfg.HC_VINCULUM_VENDOR_CODE || cfg.VINCULUM_USER || '';

  /**
   * Vinculum client for one region. UAE and KSA are different seller accounts on the
   * same portal, so a region gets its own login or it does not run at all. An injected
   * client (tests) always wins.
   */
  const vinByRegion = new Map();
  function vinFor(region = 'uae') {
    if (vinculumClient) return { client: vinculumClient, creds: vinculumCredsFor(cfg, region) };
    const creds = vinculumCredsFor(cfg, region);
    if (!creds.configured) return { client: null, creds };
    if (!vinByRegion.has(creds.region)) {
      vinByRegion.set(creds.region, makeVinculumClient({
        baseUrl: creds.baseUrl, userName: creds.user, password: creds.pass,
      }));
    }
    return { client: vinByRegion.get(creds.region), creds };
  }

  const vin = vinculumClient || makeVinculumClient({
    baseUrl: cfg.VINCULUM_BASE_URL,
    userName: cfg.VINCULUM_USER,
    password: cfg.VINCULUM_PASS,
  });
  const fulfill = makeVinculumFulfill(vin, { fulfillActionsJson: cfg.VINCULUM_FULFILL_ACTIONS_JSON });

  function mapSku(hcSku) {
    if (!hcSku) throw new Error('HC SKU missing on order row');
    if (skuMap[hcSku]) return skuMap[hcSku];
    return hcSku;
  }

  function orderUc() {
    const target = ordersUcConfig(cfg);
    try {
      return { target, client: makeHcUcClient(target) };
    } catch (err) {
      // Fall back to injected India/shared uc ONLY for staging dry-run previews, never for writes
      // against the wrong tenant.
      if (ucFallback && target.label === 'staging' && !target.configured) {
        return { target: { ...target, clientSource: 'fallback-shared', error: String(err.message || err) }, client: ucFallback };
      }
      throw err;
    }
  }

  function inventoryUc() {
    const target = inventoryUcConfig(cfg);
    return { target, client: makeHcUcClient(target) };
  }

  async function createB2cSaleOrder(uc, target, order) {
    const orderCode = soCodeFor(order.webOrderNo);
    const displayOrderCode = String(order.webOrderNo || orderCode).trim();
    const ucSku = mapSku(order.hcSku);
    // Staging proof historically maps unknown HC SKUs → optest when HC_STAGING_SKU_FALLBACK is set.
    const itemSku = (target.label === 'staging' && cfg.HC_STAGING_SKU_FALLBACK)
      ? (skuMap[order.hcSku] || cfg.HC_STAGING_SKU_FALLBACK)
      : ucSku;
    const price = Number(order.price || order.lineAmount || 0) || 0;
    const qty = Math.max(1, Number(order.qty) || 1);
    const customerCode = target.customerCode;
    if (!customerCode) throw new Error('HC customer code missing, set HC_CUSTOMER_CODE / HC_UC_STAGING_CUSTOMER (no new customer create)');

    const fac = target.facility ? { facility: target.facility } : {};
    // Staging tenant is India, GCC order address (DU/Dubai) fails SO create validation.
    // For staging proof, force India-safe geo; keep buyer name/phone/line1 from the order.
    const staging = target.label === 'staging';
    const addr = {
      id: 'a1',
      name: order.customerName || order.buyerName || 'Home Centre Buyer',
      addressLine1: order.addressLine1 || order.buyerAddress || 'NA',
      city: staging ? 'New Delhi' : (order.city || 'Dubai'),
      state: staging ? 'DL' : (order.state || 'DU'),
      country: staging ? 'IN' : (order.country || 'United Arab Emirates'),
      pincode: String(staging ? '110001' : (order.pincode || order.zip || '00000')),
      phone: String(order.phone || order.buyerPhone || '0000000000'),
      email: order.email || order.customerEmail || '',
    };
    const saleOrderItems = [];
    for (let u = 0; u < qty; u++) {
      saleOrderItems.push({
        code: `${orderCode}-${u + 1}`,
        itemSku,
        sellingPrice: price,
        totalPrice: price,
        shippingMethodCode: target.shipMethod || 'STD',
        facilityCode: target.facility || undefined,
      });
    }
    const saleOrder = {
      code: orderCode,
      displayOrderCode,
      channel: target.channel || 'CUSTOM',
      cashOnDelivery: !!order.cashOnDelivery,
      currencyCode: target.currency || 'INR',
      customerCode,
      addresses: [addr],
      billingAddress: { referenceId: 'a1' },
      shippingAddress: { referenceId: 'a1' },
      saleOrderItems,
    };
    await uc.public('/services/rest/v1/oms/saleOrder/create', { saleOrder }, fac);
    return { soCode: orderCode, displayOrderCode, ucSku: itemSku, qty, price, customerCode, channel: saleOrder.channel };
  }

  async function soExists(uc, target, soCode) {
    const fac = target.facility ? { facility: target.facility } : {};
    try {
      const existing = await uc.public(
        '/services/rest/v1/oms/saleOrder/get',
        { saleOrderCode: soCode },
        { ...fac, idempotent: true },
      );
      if (existing?.saleOrderDTO || existing?.saleOrder || existing?.code || existing?.successful) {
        return true;
      }
    } catch { /* not found */ }
    return false;
  }

  function mergeBuyer(order, extra = {}) {
    return { ...order, ...extra };
  }

  async function punchOne(order, { dryRun, mode } = {}) {
    const webOrderNo = order.webOrderNo;
    if (!webOrderNo) return { ok: false, error: 'missing webOrderNo' };
    const soCode = soCodeFor(webOrderNo);
    const targetCfg = ordersUcConfig(cfg);
    const resolved = mode || resolveHcMode(cfg, { dryRun });

    if (resolved.dryRun || !resolved.allowOrderWrite) {
      // Mirror createB2cSaleOrder staging fallback so dry-run preview matches write SKU.
      const previewSku = (targetCfg.label === 'staging' && cfg.HC_STAGING_SKU_FALLBACK && !skuMap[order.hcSku])
        ? cfg.HC_STAGING_SKU_FALLBACK
        : mapSku(order.hcSku);
      return {
        ok: true,
        dryRun: true,
        webOrderNo,
        soCode,
        displayOrderCode: webOrderNo,
        hcSku: order.hcSku,
        ucSku: previewSku,
        price: order.price,
        qty: order.qty,
        channel: targetCfg.channel,
        ucTarget: targetCfg.label,
        ucBaseUrl: targetCfg.baseUrl,
        customerCode: targetCfg.customerCode,
        mode: resolved.modeLabel,
        gated: !resolved.allowOrderWrite,
      };
    }

    if (targetCfg.label === 'uae' && !resolved.live) {
      return { ok: false, webOrderNo, soCode, error: 'HC_LIVE=false, refusing UAE/production SO create' };
    }

    let uc;
    try {
      ({ client: uc } = orderUc());
    } catch (err) {
      return { ok: false, webOrderNo, soCode, error: String(err.message || err), ucTarget: targetCfg.label };
    }

    try {
      if (await soExists(uc, targetCfg, soCode)) {
        return { ok: true, webOrderNo, soCode, skipped: true, reason: 'so_already_exists', ucTarget: targetCfg.label };
      }
      // Also skip if display order code already exists under same code without HC- prefix
      if (webOrderNo !== soCode && await soExists(uc, targetCfg, webOrderNo)) {
        return { ok: true, webOrderNo, soCode: webOrderNo, skipped: true, reason: 'display_order_exists', ucTarget: targetCfg.label };
      }

      const so = await createB2cSaleOrder(uc, targetCfg, order);
      return { ok: true, webOrderNo, ...so, ucTarget: targetCfg.label, ucBaseUrl: targetCfg.baseUrl, mode: resolved.modeLabel };
    } catch (err) {
      const msg = String(err.message || err);
      // "Already exists" is the one failure that is really a success, the order was
      // punched by an earlier run. But the old test was /already|duplicate|exist/i,
      // which also matched "item does not exist" and "SKU does not exist": a genuinely
      // unmapped SKU was reported as ok:true, skipped, so a whole sync could look clean
      // while punching nothing. Require an affirmative duplicate phrase, and never
      // treat a negated one as success.
      const negated = /(does\s*not|doesn't|no such|not\s+found|invalid|unknown)/i.test(msg);
      const duplicate = /(already\s+exists|duplicate|already\s+present|already\s+created)/i.test(msg);
      if (duplicate && !negated) {
        return { ok: true, webOrderNo, soCode, skipped: true, reason: msg, ucTarget: targetCfg.label };
      }
      return { ok: false, webOrderNo, soCode, error: msg, ucTarget: targetCfg.label };
    }
  }

  async function syncOrders({ dryRun, limit = 50, source = 'active', buyerByOrder = {} } = {}) {
    const mode = resolveHcMode(cfg, { dryRun });
    const targetCfg = ordersUcConfig(cfg);
    let page;
    try {
      page = source === 'archive'
        ? await vin.listArchiveOrders({ rows: Math.min(200, Math.max(limit, 50)) })
        : await vin.listActiveOrders({ rows: Math.min(200, Math.max(limit, 50)) });
    } catch (err) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        ordersTarget: mode.ordersTarget,
        ucTarget: targetCfg.label,
        ucBaseUrl: targetCfg.baseUrl,
        source,
        fetched: 0,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        ownerEmail,
        error: String(err.message || err),
        message: 'Could not list Home Centre orders (check Vinculum login)',
      };
    }
    const orders = (page.orders || []).slice(0, limit).map((o) => mergeBuyer(o, buyerByOrder[o.webOrderNo] || {}));
    if (!orders.length) {
      return {
        ok: true,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        ordersTarget: mode.ordersTarget,
        ucTarget: targetCfg.label,
        ucBaseUrl: targetCfg.baseUrl,
        source,
        fetched: page.records ?? 0,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        empty: true,
        ownerEmail,
        message: 'No Home Centre orders to process, nothing to do',
      };
    }

    if (!mode.dryRun && !mode.allowOrderWrite) {
      return {
        ok: false,
        dryRun: true,
        mode: mode.modeLabel,
        ordersTarget: mode.ordersTarget,
        message: 'Order writes gated, set dryRun=false; staging needs HC_UC_STAGING_* creds; UAE needs HC_LIVE=true + HC_ORDERS_UC_TARGET=uae',
        fetched: page.records,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        ownerEmail,
      };
    }

    if (!mode.dryRun && !targetCfg.configured) {
      return {
        ok: false,
        dryRun: false,
        mode: mode.modeLabel,
        ordersTarget: mode.ordersTarget,
        ucTarget: targetCfg.label,
        ucBaseUrl: targetCfg.baseUrl,
        fetched: page.records,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        ownerEmail,
        error: `Missing credentials for ${targetCfg.label} UC`,
        message: `Set HC_UC_${targetCfg.label === 'staging' ? 'STAGING' : 'UAE'}_USER/PASS in VM .env (instance-specific; never India UC_USER)`,
      };
    }

    const results = [];
    for (const order of orders) {
      results.push(await punchOne(order, { dryRun: mode.dryRun, mode }));
    }
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    const created = results.filter((r) => r.ok && !r.dryRun && !r.skipped).length;
    return {
      ok: failed === 0,
      dryRun: mode.dryRun,
      mode: mode.modeLabel,
      ordersTarget: mode.ordersTarget,
      ucTarget: targetCfg.label,
      ucBaseUrl: targetCfg.baseUrl,
      source,
      fetched: page.records,
      processed: results.length,
      okCount,
      failed,
      created,
      results,
      ownerEmail,
      message: failed
        ? `${failed} order(s) failed`
        : (mode.dryRun ? `Dry-run preview ${okCount} order(s) → ${targetCfg.label}` : `Created/skipped ${okCount} order(s) on ${targetCfg.label}`),
    };
  }

  /**
   * Download Vinculum seller SKU list → merge UAE UC quantities → optional upload.
   * Identity match on seller skuCode (not archive LAND*). Upload only when HC_LIVE.
   */
  async function syncInventory({
    dryRun, sellerCode = null, skus = null, region = 'uae', onProgress = null,
  } = {}) {
    // Narrates what the job is doing so the screen can show it live. Never throws:
    // a reporting failure must not stop the sync it is describing.
    const step = async (name, state = 'done', detail = '') => {
      try { await onProgress?.({ step: name, state, detail }); } catch { /* ignore */ }
    };
    const mode = resolveHcMode(cfg, { dryRun });
    // Stock for a region lives in that region's own UC tenant, and its seller account
    // is a different Vinculum login. Both must follow the region or KSA quantities end
    // up on the UAE storefront.
    const invTarget = inventoryUcConfig(cfg, region);
    const { client: regionVin, creds } = vinFor(region);

    if (!regionVin) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        region: creds.region,
        configured: false,
        message: creds.missingReason,
      };
    }

    const invFacility = invTarget.invFacility || invTarget.facility
      || (creds.region === 'ksa' ? '' : 'opptrauae');
    const vinVendor = creds.vendorCode || vendorCode || '';
    const effectiveSellerCode = sellerCode ?? creds.sellerCode
      ?? (creds.region === 'uae' ? sellerCodeUae : sellerCodeOther);
    const vin = regionVin;

    if (!invTarget.configured) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        inventoryTarget: invTarget.label,
        ucBaseUrl: invTarget.baseUrl,
        facility: invFacility,
        sellerCode: effectiveSellerCode || null,
        ownerEmail,
        error: 'UAE UC credentials missing',
        message: 'Set HC_UC_UAE_USER/PASS (+ HC_UC_UAE_BASE_URL / FACILITY) in VM .env',
        rows: [],
      };
    }

    // 1) Download current seller inventory list from Vinculum (not blank import template, not archive LAND*).
    let hcSkus = [];
    try {
      if (Array.isArray(skus) && skus.length) {
        // Explicit skus[] = UC skuCodes to push; synthesize minimal HC rows (identity).
        hcSkus = skus.map((s) => ({
          mrktSku: String(s),
          skuCode: String(s),
          mfgSku: String(s),
          isbn: '',
          qty: 0,
          salePrice: '',
          mrp: '',
          sellerCode: effectiveSellerCode || vinVendor,
          skuShortName: '',
          webStatus: '',
          skuSize: '',
          skuColor: '',
        }));
      } else if (typeof vin.listAllSellerSkus === 'function') {
        await step(`Signing in to Home Centre (${creds.region.toUpperCase()})`, 'running');
        await step('Downloading the seller product list from Home Centre', 'running');
        const listed = await vin.listAllSellerSkus({ vendorCode: vinVendor });
        await step('Downloading the seller product list from Home Centre', 'done', `${listed?.length ?? 0} products`);
        hcSkus = listed.skus || [];
      } else {
        return {
          ok: false,
          dryRun: mode.dryRun,
          error: 'Vinculum client missing listAllSellerSkus',
          message: 'Update @opptra/integrations-vinculum for seller SKU download',
          rows: [],
          ownerEmail,
        };
      }
    } catch (err) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        error: String(err.message || err),
        message: 'Could not download Vinculum seller SKU list (jsonSellerSkuEnqBS)',
        rows: [],
        ownerEmail,
        vendorCode: vinVendor,
      };
    }

    if (!hcSkus.length) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        inventoryTarget: invTarget.label,
        vendorCode: vinVendor,
        ownerEmail,
        error: 'No seller SKUs returned from Vinculum',
        message: `Vinculum vendorCode=${vinVendor || '(empty)'} returned 0 SKUs. Confirm VINCULUM_USER / HC_VINCULUM_VENDOR_CODE.`,
        rows: [],
        mappingHint: {
          note: 'Inventory uses seller SKU list (skuCode e.g. T80358), not archive order LAND* codes',
          facility: 'Use HC_UC_UAE_INV_FACILITY=opptrauae for stock (OPP_RFS_FZ_UAE often empty for these SKUs)',
        },
      };
    }

    let uc;
    try {
      ({ client: uc } = inventoryUc());
    } catch (err) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        error: String(err.message || err),
        message: 'Could not build UAE UC client',
        rows: [],
        ownerEmail,
      };
    }

    // 2) Pull UC inventory for identity-matched seller skuCodes (+ optional HC_SKU_MAP_JSON overrides).
    const ucSkuList = [...new Set(hcSkus.map((h) => {
      const mapped = skuMap[h.skuCode] || skuMap[h.mrktSku];
      return String(mapped || h.skuCode || '').trim();
    }).filter(Boolean))];

    let snapBySku = {};
    try {
      await step(`Reading stock from Unicommerce (${invTarget.label.toUpperCase()})`, 'running', `${ucSkuList.length} SKUs`);
      snapBySku = await inventorySnapshotBySku(uc, ucSkuList, invFacility);
      await step(`Reading stock from Unicommerce (${invTarget.label.toUpperCase()})`, 'done', `${Object.keys(snapBySku || {}).length} matched`);
      // Fallback: if configured inv facility yields nothing, try the session facility once.
      if (!Object.keys(snapBySku).length && invTarget.facility && invTarget.facility !== invFacility) {
        snapBySku = await inventorySnapshotBySku(uc, ucSkuList, invTarget.facility);
      }
    } catch (err) {
      return {
        ok: false,
        dryRun: mode.dryRun,
        mode: mode.modeLabel,
        inventoryTarget: invTarget.label,
        ucBaseUrl: invTarget.baseUrl,
        facility: invFacility,
        ownerEmail,
        error: String(err.message || err),
        message: 'UAE UC inventory snapshot failed',
        rows: [],
      };
    }

    // Identity map: every seller skuCode is the UC key. Missing snapshot row ⇒ qty 0
    // (SKU may exist in catalog with no facility inventory record).
    // Do NOT pre-fill all keys before merge, inventory-row match ≠ catalog match.
    const ucQtyBySku = {};
    let withInvRow = 0;
    let withPosQty = 0;
    for (const [sku, s] of Object.entries(snapBySku)) {
      const q = availableQty(s);
      ucQtyBySku[sku] = q;
      withInvRow++;
      if (q > 0) withPosQty++;
    }
    const merged = mergeSellerInventoryRows(hcSkus, ucQtyBySku, {
      skuMap,
      sellerCode: effectiveSellerCode || '',
    });
    const rows = merged.rows;

    // Structural validation always (blanks, dups, LAND*, negative/NaN qty).
    // Catalog matchRate===1 is required only for live Vinculum upload.
    let catalog = { matched: null, missing: [], total: ucSkuList.length, matchRate: null };
    const structural = validateInventoryFill(rows, {
      expectedCount: hcSkus.length,
      qtyErrors: merged.qtyErrors,
    });
    let validation = structural;

    // 3) Upload only when HC_LIVE (never in dry-run) AND validation gate passes.
    let upload = { skipped: true, reason: 'dry-run or HC_LIVE=false' };
    let workbookBytes = 0;
    try {
      await step('Filling the Home Centre inventory template', 'running', `${rows.length} rows`);
      const buf = await buildInventoryXlsx(rows);
      await step('Filling the Home Centre inventory template', 'done', `${rows.length} rows`);
      workbookBytes = buf.length;
      if (mode.allowVinculumInventoryWrite) {
        catalog = await catalogMatchSkus(uc, ucSkuList);
        validation = validateInventoryFill(rows, {
          expectedCount: hcSkus.length,
          qtyErrors: merged.qtyErrors,
          catalogMatchRate: catalog.matchRate,
        });
        if (!validation.ok || catalog.matchRate !== 1) {
          upload = {
            skipped: true,
            reason: 'validation gate refused live upload',
            matchRate: catalog.matchRate,
            validationErrors: validation.errors,
          };
        } else {
          await step('Uploading the updated file to Home Centre', 'running');
          upload = await vin.uploadInventoryWorkbook(buf, `hc-inv-${creds.region}-${effectiveSellerCode || vinVendor || 'seller'}.xlsx`);
          await step('Uploading the updated file to Home Centre', upload?.ok ? 'done' : 'failed', upload?.reason || '');
        }
      }
    } catch (err) {
      if (mode.allowVinculumInventoryWrite) {
        upload = { ok: false, error: String(err.message || err) };
      } else {
        return {
          ok: false,
          dryRun: true,
          error: String(err.message || err),
          message: 'Failed to build inventory workbook (dry-run fill)',
          rows: [],
          ownerEmail,
        };
      }
    }

    const gateBlocked = upload.skipped && upload.reason === 'validation gate refused live upload';
    const ok = !gateBlocked && structural.ok && (upload.skipped || upload.ok !== false);
    return {
      ok,
      dryRun: mode.dryRun || !mode.allowVinculumInventoryWrite || gateBlocked,
      mode: mode.modeLabel,
      inventoryTarget: invTarget.label,
      ucBaseUrl: invTarget.baseUrl,
      facility: invFacility,
      vendorCode: vinVendor,
      sellerCode: effectiveSellerCode || (rows[0]?.sellerCode || null),
      skuCount: rows.length,
      // Inventory-row presence at facility (expected <100% → qty 0 fill).
      matched: merged.matched,
      missingUc: merged.missingUc,
      matchPct: merged.matchPct,
      // Catalog identity (live gate uses this; null on dry-run unless probed).
      catalogMatched: catalog.matched,
      catalogMissing: catalog.missing,
      catalogMatchRate: catalog.matchRate,
      inventoryRowsAtFacility: withInvRow,
      positiveQtySkus: withPosQty,
      totalQty: rows.reduce((n, r) => n + (Number(r.sellerInv) || 0), 0),
      workbookBytes,
      validationErrors: validation.errors,
      validationOk: validation.ok,
      rows: rows.slice(0, mode.allowVinculumInventoryWrite ? 50 : 20),
      samplePairs: rows.filter((r) => Number(r.sellerInv) > 0).slice(0, 8).map((r) => ({
        marketplaceSku: r.marketplaceSku,
        vendorSku: r.vendorSku,
        ucSku: r.ucSku,
        sellerInv: r.sellerInv,
        priorSellerInv: r.priorSellerInv,
      })),
      sampleZeroQty: rows.filter((r) => Number(r.sellerInv) === 0).slice(0, 8).map((r) => ({
        marketplaceSku: r.marketplaceSku,
        vendorSku: r.vendorSku,
        ucSku: r.ucSku,
        priorSellerInv: r.priorSellerInv,
      })),
      upload,
      ownerEmail,
      identityMapEnough: Object.keys(skuMap).length === 0,
      message: gateBlocked
        ? `Refused live upload: validation gate (matchRate=${catalog.matchRate}; ${validation.errors.length} error(s))`
        : mode.allowVinculumInventoryWrite
          ? (upload.ok
            ? `Uploaded ${rows.length} SKU(s) to Vinculum (identity fill; ${withPosQty} with qty>0)`
            : `Upload failed: ${upload.error || upload.preview || 'unknown'}`)
          : `Dry-run fill ${rows.length} SKU(s) from Vinculum list + UAE UC @ ${invFacility} (identity map; ${withInvRow} inv rows / ${withPosQty} qty>0; upload gated until HC_LIVE=true)`,
    };
  }

  async function fulfillOrders({ dryRun = false, limit = 20, webOrderNos = null } = {}) {
    // Explicitly out of scope for current go-live, keep dry-run stub only.
    if (dryRun || !truthyLive(cfg)) {
      return {
        ok: true,
        dryRun: true,
        processed: 0,
        okCount: 0,
        failed: 0,
        results: [],
        message: 'Fulfill (invoice/transporter/acceptance) is OUT OF SCOPE, dry-run only',
        actionsConfigured: fulfill.actionsConfigured,
      };
    }
    return {
      ok: false,
      processed: 0,
      okCount: 0,
      failed: 0,
      results: [],
      message: 'Fulfill writes disabled until explicitly scoped back in',
      actionsConfigured: fulfill.actionsConfigured,
    };
  }

  function truthyLive(c) {
    return /^(1|true|yes|on)$/i.test(String(c.HC_LIVE ?? '').trim());
  }

  async function status() {
    const mode = resolveHcMode(cfg);
    const stg = stagingUcConfig(cfg);
    const uae = uaeUcConfig(cfg);
    let vinculumOk = false;
    let vinculumError = null;
    if (cfg.VINCULUM_USER && cfg.VINCULUM_PASS) {
      try {
        await vin.login();
        vinculumOk = true;
      } catch (err) {
        vinculumError = String(err.message || err);
      }
    }
    return {
      ok: true,
      ownerEmail,
      mode: mode.modeLabel,
      live: mode.live,
      dryRunDefault: mode.dryRun,
      ordersTarget: mode.ordersTarget,
      staging: { baseUrl: stg.baseUrl, facility: stg.facility, channel: stg.channel, customerCode: stg.customerCode, configured: stg.configured },
      uae: { baseUrl: uae.baseUrl, facility: uae.facility, channel: uae.channel, customerCode: uae.customerCode, configured: uae.configured },
      vinculum: { configured: !!(cfg.VINCULUM_USER && cfg.VINCULUM_PASS), loginOk: vinculumOk, error: vinculumError },
      sellerCodes: { uae: sellerCodeUae, other: sellerCodeOther },
      syncMinutes: Number(cfg.HC_SYNC_MINUTES || 0),
    };
  }

  return {
    syncOrders,
    syncInventory,
    punchOne,
    fulfillOrders,
    status,
    mapSku,
    soCodeFor,
    vinculum: vin,
    resolveHcMode: (input) => resolveHcMode(cfg, input),
  };
}

export {
  parseSkuMap,
  vinculumCredsFor,
  resolveHcMode,
  ordersUcConfig,
  inventoryUcConfig,
  stagingUcConfig,
  uaeUcConfig,
} from './targets.js';
