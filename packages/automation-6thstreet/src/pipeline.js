/**
 * 6th Street automation pipeline
 *
 * PRIMARY: pick list + invoice + shipping label → email daniyal@opptra.com
 *   - Selling price ONLY from invoice (see price.js)
 * SECONDARY: UC inventory snapshot → 6th Street portal update (HAR-gated)
 *
 * Portal/OMS XHR not reversed yet — downloaders return awaitingHar / accept injected artifacts for dry-run/tests.
 */

import { gmailApi } from '@opptra/integrations-google';
import { UcClient, PgSessionStore, normalizeInstanceId } from '@opptra/uc-client';
import { extractInvoiceSellingPrice, missingInvoicePrice } from './price.js';
import { buildPicklistXlsx } from './picklistFile.js';
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

export function makeSixthStreetPipeline(uc, cfg, google, { portalClient } = {}) {
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
   * Download helpers — plug real RE client when HAR lands.
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
      error: '6th Street picklist/invoice/label download APIs not reversed yet — need HAR (docs/connectors/6thstreet.md)',
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

    const subject = `6th Street pack — ${okCount} order(s)`;
    const htmlBody = [
      '<p>6th Street pick list / invoice / shipping label pack.</p>',
      '<p>Selling prices below are <b>from invoice only</b>.</p>',
      '<ul>',
      ...priceRows.map((p) => `<li>${p.orderId}: ${p.sellingPrice} (${p.source})</li>`),
      '</ul>',
      dryRun ? '<p><i>Dry-run — email not sent.</i></p>' : '',
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
          : 'Dry-run / Gmail not connected — preview only. Connect Gmail (Packing Mail style) to draft/send.',
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
   * Reads from STREET6_UC_INSTANCE (prefer ksa — sample invoice SKU lives there).
   * Never writes to portal unless STREET6_LIVE + not dry-run (still awaiting working login + HAR).
   */
  async function syncInventory({ dryRun = true, skus = null } = {}) {
    const target = resolveStreet6UcTarget(cfg);
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
    const client = target.label === 'india' && uc && typeof uc.public === 'function'
      ? uc
      : makeStreet6UcClient(target);
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

    const skuList = Array.isArray(skus) ? skus.map(String).filter(Boolean).slice(0, 50) : [];
    let snapshots = [];
    let sample = null;
    try {
      if (skuList.length) {
        const fac = target.facility ? { facility: target.facility } : {};
        const snap = await client.public(
          '/services/rest/v1/inventory/inventorySnapshot/get',
          { itemTypeSKUs: skuList },
          { ...fac, idempotent: true },
        );
        snapshots = snap?.inventorySnapshots || [];
        sample = snapshots[0] || null;
      }
    } catch (err) {
      return {
        ok: false,
        dryRun,
        ownerEmail,
        ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl },
        error: String(err.message || err).slice(0, 200),
        message: 'UC inventory read failed',
        probedSkus: skuList,
      };
    }

    if (dryRun || !live) {
      return {
        ok: true,
        dryRun: true,
        ownerEmail,
        ucTarget: { label: target.label, facility: target.facility, baseUrl: target.baseUrl, note: target.note },
        sampleSku: skuList[0] || null,
        samplePresent: !!sample,
        snapshotCount: snapshots.length,
        snapshots: snapshots.slice(0, 10).map((s) => ({
          sku: s.itemTypeSKU,
          inventory: s.inventory,
          openSale: s.openSale,
        })),
        awaitingHar: true,
        portalLoginRequired: true,
        message: 'UC→6th Street inventory push awaiting portal login + upload HAR; dry-run only (STREET6_LIVE gates writes)',
      };
    }

    return {
      ok: false,
      dryRun: false,
      awaitingHar: true,
      ownerEmail,
      message: 'Portal inventory update refused — need working portal login + upload HAR; STREET6_LIVE alone is not enough',
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
