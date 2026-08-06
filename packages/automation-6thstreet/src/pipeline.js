/**
 * 6th Street automation pipeline
 *
 * PRIMARY: pick list + invoice + shipping label → email daniyal@opptra.com
 *   - Selling price ONLY from invoice (see price.js)
 * SECONDARY: UC inventory snapshot → 6th Street portal update (HAR-gated)
 *
 * Portal/OMS XHR not reversed yet, downloaders return awaitingHar / accept injected artifacts for dry-run/tests.
 */

import { gmailApi } from '@opptra/integrations-google';
import { UcClient, PgSessionStore, normalizeInstanceId } from '@opptra/uc-client';
import { extractInvoiceSellingPrice, missingInvoicePrice } from './price.js';
import { buildPicklistXlsx } from './picklistFile.js';
import { makeStreet6PortalClient } from '@opptra/connectors-6thstreet';
import { resolveStreet6UcTarget } from './targets.js';
import { packAttachmentName, street6OmsHomeUrl } from './artifacts.js';

function emailTo(cfg) {
  return cfg.STREET6_EMAIL_TO || 'daniyal@opptra.com';
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

/** Dedicated UC client for STREET6_UC_INSTANCE (never mutates India vault when instance ≠ india). */
function makeStreet6UcClient(target) {
  if (!target?.baseUrl) return null;
  const instanceId = normalizeInstanceId(target.label || 'india');
  return new UcClient({
    baseUrl: target.baseUrl,
    user: target.user || '',
    pass: target.pass || '',
    defaultFacility: target.facility || '',
    instanceId,
    sessionStore: new PgSessionStore({ instanceId }),
    rps: 2,
    burst: 4,
  });
}

// UC caps how many SKUs one inventorySnapshot call accepts.
const SNAPSHOT_BATCH = 50;

/**
 * Sellable quantity: what is physically there minus what is already promised.
 * Publishing raw `inventory` would oversell, because units on unshipped orders are
 * still counted there. Never negative.
 */
function sellableFrom(snap) {
  if (!snap) return 0;
  const onHand = Number(snap.inventory) || 0;
  const promised = Number(snap.openSale ?? snap.allocated ?? snap.blocked ?? 0) || 0;
  return Math.max(0, Math.trunc(onHand - promised));
}

/**
 * 6th Street's inventory list comes back in whatever shape their portal uses. Accept
 * the common envelopes rather than assuming one, and keep only rows with a SKU.
 */
function normalizePortalInventory(data) {
  const list = Array.isArray(data) ? data
    : data?.items || data?.data || data?.inventory || data?.rows || data?.content || [];
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => ({
      sku: String(r?.sku ?? r?.Sku ?? r?.SKU ?? r?.skuCode ?? r?.barcode ?? '').trim(),
      portalCount: Number(r?.count ?? r?.Count ?? r?.quantity ?? r?.qty ?? 0) || 0,
    }))
    .filter((r) => r.sku);
}

function parseSkuMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('must be an object');
    return p;
  } catch (err) {
    throw new Error(`STREET6_SKU_MAP_JSON is not valid JSON (${err.message}). Fix it or unset it.`);
  }
}

export function makeSixthStreetPipeline(uc, cfg, google, { portalClient, ucClientFor } = {}) {
  // 6th Street lists barcodes/EANs. Where those are not the UC sku code, this map
  // translates them. Empty means "assume they are the same", which is true for some
  // catalogues and provably false for KSA today.
  const skuMap = parseSkuMap(cfg.STREET6_SKU_MAP_JSON);
  // A real portal client whenever credentials exist; tests inject their own.
  const portal = portalClient || ((cfg.STREET6_PORTAL_USER && cfg.STREET6_PORTAL_PASS)
    ? makeStreet6PortalClient({
      baseUrl: cfg.STREET6_PORTAL_API_BASE,
      username: cfg.STREET6_PORTAL_USER,
      password: cfg.STREET6_PORTAL_PASS,
    })
    : null);
  const ownerEmail = cfg.STREET6_OWNER_EMAIL || 'daniyal@opptra.com';
  // Env string "false" must NOT count as live (Boolean("false") === true).
  const live = truthy(cfg.STREET6_LIVE);
  const dryRunDefault = cfg.STREET6_DRY_RUN === undefined || cfg.STREET6_DRY_RUN === ''
    ? true
    : truthy(cfg.STREET6_DRY_RUN);

  function vpnReady() {
    return !!(cfg.STREET6_VPN_USER && cfg.STREET6_VPN_PASS && cfg.STREET6_VPN_HOST);
  }

  function portalReady() {
    return !!(cfg.STREET6_PORTAL_USER && cfg.STREET6_PORTAL_PASS);
  }

  function omsReady() {
    return !!(cfg.STREET6_OMS_USER && cfg.STREET6_OMS_PASS);
  }

  /**
   * Download helpers, plug real RE client when HAR lands.
   * For tests / operator Path B: pass artifacts on each order.
   */
  async function fetchPackArtifacts(orderId, injected = null) {
    if (injected?.picklistBuffer || injected?.invoiceBuffer || injected?.labelBuffer || injected?.invoice) {
      return {
        ok: true,
        source: 'injected',
        picklistBuffer: injected.picklistBuffer || null,
        invoiceBuffer: injected.invoiceBuffer || null,
        labelBuffer: injected.labelBuffer || null,
        invoice: injected.invoice || null,
        picklistRows: injected.picklistRows || [],
      };
    }
    if (portalClient?.downloadPack) {
      return portalClient.downloadPack(orderId);
    }
    return {
      ok: false,
      awaitingHar: true,
      vpnConfigured: vpnReady(),
      portalConfigured: portalReady(),
      omsConfigured: omsReady(),
      omsHomeUrl: street6OmsHomeUrl(cfg),
      error: '6th Street picklist/invoice/label download APIs not reversed yet, need HAR (docs/connectors/6thstreet.md)',
    };
  }

  async function emailPack({
    orderIds = [],
    dryRun = true,
    send = false,
    artifactsByOrder = {},
  } = {}) {
    const to = emailTo(cfg);
    const ids = (orderIds || []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) {
      return { ok: true, empty: true, processed: 0, message: 'No order ids', ownerEmail, dryRun };
    }

    const results = [];
    const attachments = [];
    const priceRows = [];

    for (const orderId of ids) {
      const art = await fetchPackArtifacts(orderId, artifactsByOrder[orderId]);
      if (!art.ok) {
        results.push({ orderId, ok: false, error: art.error, awaitingHar: !!art.awaitingHar });
        continue;
      }

      const price = extractInvoiceSellingPrice(art.invoice || {});
      if (!price.ok) {
        results.push({ orderId, ...missingInvoicePrice(orderId, price.error) });
        continue;
      }
      priceRows.push({ orderId, sellingPrice: price.sellingPrice, source: price.source });

      let pickBuf = art.picklistBuffer;
      if (!pickBuf && art.picklistRows?.length) {
        pickBuf = await buildPicklistXlsx(art.picklistRows);
      }
      if (pickBuf) {
        attachments.push({
          filename: packAttachmentName(orderId, 'picklist'),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: pickBuf,
        });
      }
      if (art.invoiceBuffer) {
        attachments.push({
          filename: packAttachmentName(orderId, 'invoice'),
          contentType: 'application/pdf',
          buffer: art.invoiceBuffer,
        });
      }
      if (art.labelBuffer) {
        attachments.push({
          filename: packAttachmentName(orderId, 'label'),
          contentType: 'application/pdf',
          buffer: art.labelBuffer,
        });
      }
      results.push({
        orderId,
        ok: true,
        sellingPrice: price.sellingPrice,
        hasPicklist: !!pickBuf,
        hasInvoice: !!art.invoiceBuffer,
        hasLabel: !!art.labelBuffer,
      });
    }

    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    if (!okCount) {
      return {
        ok: false,
        dryRun,
        ownerEmail,
        processed: results.length,
        okCount: 0,
        failed,
        results,
        message: 'No orders produced pack attachments (HAR missing or invoice price missing)',
        awaitingHar: results.some((r) => r.awaitingHar),
      };
    }

    const subject = `6th Street pack, ${okCount} order(s)`;
    const htmlBody = [
      '<p>6th Street pick list / invoice / shipping label pack.</p>',
      '<p>Selling prices below are <b>from invoice only</b>.</p>',
      '<ul>',
      ...priceRows.map((p) => `<li>${p.orderId}: ${p.sellingPrice} (${p.source})</li>`),
      '</ul>',
      dryRun ? '<p><i>Dry-run, email not sent.</i></p>' : '',
    ].join('\n');

    if (dryRun || !google?.gmail) {
      return {
        ok: failed === 0,
        dryRun: true,
        ownerEmail,
        to,
        processed: results.length,
        okCount,
        failed,
        results,
        attachmentCount: attachments.length,
        preview: { subject, to, attachmentNames: attachments.map((a) => a.filename) },
        message: google?.gmail
          ? `Dry-run: would email ${to} with ${attachments.length} attachment(s)`
          : 'Dry-run / Gmail not connected, preview only. Connect Gmail (Packing Mail style) to draft/send.',
        gmailConfigured: !!google?.gmail,
      };
    }

    const mail = { to, subject, htmlBody, attachments };
    if (send && live) {
      await gmailApi.send(google.gmail, mail);
      return {
        ok: failed === 0,
        dryRun: false,
        sent: true,
        ownerEmail,
        to,
        processed: results.length,
        okCount,
        failed,
        results,
        attachmentCount: attachments.length,
        message: `Sent pack email to ${to}`,
      };
    }

    const draft = await gmailApi.createDraft(google.gmail, mail);
    return {
      ok: failed === 0,
      dryRun: false,
      drafted: true,
      draftId: draft?.data?.id || draft?.id || null,
      ownerEmail,
      to,
      processed: results.length,
      okCount,
      failed,
      results,
      attachmentCount: attachments.length,
      message: `Draft created for ${to} (review in Gmail). Set send:true + STREET6_LIVE to auto-send.`,
    };
  }

  /**
   * Secondary: pull UC inventory snapshot rows → portal push (HAR/password-gated).
   * Reads from STREET6_UC_INSTANCE (prefer ksa, sample invoice SKU lives there).
   * Never writes to portal unless STREET6_LIVE + not dry-run (still awaiting working login + HAR).
   */
  async function syncInventory({ dryRun = true, skus = null, region = '', ucInstance = '' } = {}) {
    const target = resolveStreet6UcTarget(cfg, ucInstance || region);
    if (!target.configured) {
      return {
        ok: true,
        empty: true,
        configured: false,
        dryRun,
        ownerEmail,
        ucTarget: { label: target.label, baseUrl: target.baseUrl, facility: target.facility },
        message: `UC instance '${target.label}' not configured for STREET6`,
      };
    }

    // Prefer instance-bound client (uae/ksa/staging) so we never touch India session for GCC reads.
    // India instance may use the injected shared `uc` singleton.
    // GCC regions always get their own instance-bound client; the India singleton must
    // never serve them. ucClientFor is a test seam, not a production path.
    const client = ucClientFor
      ? ucClientFor(target)
      : (target.label === 'india' && uc && typeof uc.public === 'function'
        ? uc
        : makeStreet6UcClient(target));
    if (!client || typeof client.public !== 'function') {
      return {
        ok: true,
        empty: true,
        configured: false,
        dryRun,
        ownerEmail,
        ucTarget: { label: target.label, baseUrl: target.baseUrl, facility: target.facility },
        message: 'UC client not available for inventory sync',
      };
    }

    // The SKU list is 6th Street's, not ours. Their portal publishes what it sells, we
    // fill our quantities against exactly those rows and send the same shape back.
    // Download, fill, upload. An explicit skus[] is only an override for testing.
    let skuList = Array.isArray(skus) ? skus.map(String).filter(Boolean) : [];
    let listSource = skuList.length ? 'caller' : '';
    let portalRows = [];

    if (!skuList.length) {
      if (!portal) {
        return {
          ok: false,
          dryRun,
          ownerEmail,
          needsPortalLogin: true,
          ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
          message: 'Cannot reach the 6th Street portal to download the current inventory. Set STREET6_PORTAL_USER and STREET6_PORTAL_PASS.',
          snapshotCount: 0,
        };
      }
      const live = await portal.catalogueSkus({ country: (region || ucInstance || 'ksa').toUpperCase() === 'KSA' ? 'SA' : 'AE' });
      if (live.ok !== true) {
        return {
          ok: false,
          dryRun,
          ownerEmail,
          needsPortalLogin: live.code === 'AUTH_REQUIRED' || live.code === 'AUTH_EXPIRED',
          ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
          message: `Could not download the 6th Street catalogue: ${live.error}`,
          snapshotCount: 0,
        };
      }
      // Translate through the map where one is configured, else pass through.
      skuList = (live.skus || []).map((s0) => skuMap[s0] || s0);
      portalRows = live.rows || [];
      listSource = 'portal';
      if (!skuList.length) {
        return {
          ok: false,
          dryRun,
          ownerEmail,
          ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
          message: '6th Street returned an empty product list, so there is nothing to sync.',
          snapshotCount: 0,
        };
      }
    }

    let snapshots = [];
    let sample = null;
    let batchesWithNoMatch = 0;
    const fac = target.facility ? { facility: target.facility } : {};

    // 6th Street lists its whole catalogue, most of which is not ours. Unicommerce
    // THROWS when a batch contains no SKU it recognises, so a single foreign batch
    // used to abort the entire sync. A batch with no matches is normal here and simply
    // contributes nothing.
    for (let i = 0; i < skuList.length; i += SNAPSHOT_BATCH) {
      const batch = skuList.slice(i, i + SNAPSHOT_BATCH);
      try {
        const snap = await client.public(
          '/services/rest/v1/inventory/inventorySnapshot/get',
          { itemTypeSKUs: batch },
          { ...fac, idempotent: true },
        );
        snapshots = snapshots.concat(snap?.inventorySnapshots || []);
      } catch (err) {
        const msg = String(err.message || err);
        if (/could not find any/i.test(msg)) { batchesWithNoMatch += 1; continue; }
        return {
          ok: false,
          dryRun,
          ownerEmail,
          ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
          error: msg.slice(0, 200),
          message: 'Could not read stock from Unicommerce.',
          probedSkus: skuList.length,
        };
      }
    }
    sample = snapshots[0] || null;

    if (!snapshots.length) {
      return {
        ok: false,
        dryRun,
        ownerEmail,
        ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
        probedSkus: skuList.length,
        // Show what was actually tried. Without samples this reads as a vague failure
        // and nobody can tell whether it is a facility, an instance or a mapping issue.
        triedSkus: skuList.slice(0, 10),
        mapped: Object.keys(skuMap).length > 0,
        message: `None of the ${skuList.length} products 6th Street lists exist in Unicommerce ${target.label.toUpperCase()} (facility ${target.facility || 'default'}). Tried for example: ${skuList.slice(0, 3).join(', ')}. `
          + (Object.keys(skuMap).length
            ? 'A SKU map is configured, so either it is incomplete or these products are in another instance.'
            : '6th Street lists barcodes; if Unicommerce uses different codes, set STREET6_SKU_MAP_JSON to translate them.'),
      };
    }

    // Fill every row the portal listed. A SKU UC has never heard of becomes 0 rather
    // than being dropped: leaving it out would leave 6th Street selling stock we do
    // not have.
    const bySku = new Map(snapshots.map((r) => [String(r.itemTypeSKU), r]));
    // Only send SKUs Unicommerce actually holds. 6th Street lists its entire
    // catalogue, so pushing 0 for every SKU we do not stock would zero out other
    // sellers' inventory on the storefront.
    const rows = skuList
      .filter((sku) => bySku.has(String(sku)))
      .map((sku) => ({ sku, count: sellableFrom(bySku.get(String(sku))), known: true }));
    const unknown = skuList.length - rows.length;

    const preview = {
      ok: true,
      dryRun,
      ownerEmail,
      ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
      listSource,
      skuCount: rows.length,
      matchedInUc: rows.length - unknown,
      notInUc: unknown,
      sample: rows.slice(0, 10),
      message: `Ready to send ${rows.length} products to 6th Street ${target.label.toUpperCase()}.`
        + (unknown ? ` ${unknown} are not in Unicommerce and would be set to zero.` : ''),
    };

    if (dryRun) {
      return { ...preview, message: `${preview.message} Nothing was changed, this was a preview.` };
    }
    if (!live) {
      return {
        ...preview,
        ok: false,
        message: 'Live writes are switched off for 6th Street. Set STREET6_LIVE=true to allow the upload.',
      };
    }

    // Everything past here writes to a live storefront.
    const upload = await portal.uploadInventory(rows);
    if (upload.ok !== true) {
      return {
        ...preview,
        ok: false,
        uploaded: false,
        message: `Stock was read from Unicommerce but 6th Street rejected the upload: ${upload.error}`,
      };
    }
    return {
      ...preview,
      uploaded: true,
      importRef: upload.data?.importId || upload.data?.id || null,
      message: `Sent ${rows.length} products to 6th Street ${target.label.toUpperCase()}.`
        + (unknown ? ` ${unknown} were set to zero because Unicommerce has no stock record for them.` : ''),
    };
  }

  async function status() {
    return {
      ok: true,
      ownerEmail,
      live,
      dryRunDefault,
      emailTo: emailTo(cfg),
      vpnConfigured: vpnReady(),
      portalConfigured: portalReady(),
      omsConfigured: omsReady(),
      omsHomeUrl: street6OmsHomeUrl(cfg),
      ucTarget: (() => {
        const t = resolveStreet6UcTarget(cfg);
        return { label: t.label, baseUrl: t.baseUrl, facility: t.facility, configured: t.configured, note: t.note };
      })(),
      awaitingHar: true,
      primary: 'pack.email (picklist + invoice + label → Daniyal)',
      secondary: 'inventory.push (UC → portal)',
    };
  }

  return {
    emailPack,
    syncInventory,
    status,
    extractInvoiceSellingPrice,
    /** Rebuild with operator Gmail (Packing Mail pattern). */
    withGoogle(nextGoogle) {
      return makeSixthStreetPipeline(uc, cfg, nextGoogle, { portalClient });
    },
  };
}
