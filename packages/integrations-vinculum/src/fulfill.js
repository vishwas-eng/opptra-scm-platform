// Vinculum fulfill actions (confirm → invoice → ship → label).
//
// June 2026 recon was READ-ONLY (login + order list). Write endpoints for
// Manage Orders are not yet captured. This module:
//   1) Exposes a stable API the automation can call
//   2) Uses optional cfg.fulfillActions overrides from env JSON once HAR'd
//   3) Returns clear "not_configured" so runs don't silently invent success
//
// Capture with DevTools on Manage Orders (confirm, invoice, ready, ship, print label)
// then set VINCULUM_FULFILL_ACTIONS_JSON, see docs/HOMECENTRE.md.

export function parseFulfillActions(jsonOrObj) {
  if (!jsonOrObj) return null;
  const obj = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
  return obj && typeof obj === 'object' ? obj : null;
}

/**
 * @param {ReturnType<import('./client.js').makeVinculumClient>} client
 * @param {object} cfg
 */
export function makeVinculumFulfill(client, cfg = {}) {
  const actions = parseFulfillActions(cfg.fulfillActionsJson || cfg.fulfillActions) || {};

  async function runNamed(name, order, extra = {}) {
    const spec = actions[name];
    if (!spec || !spec.action) {
      return {
        ok: false,
        skipped: true,
        step: name,
        error: `Vinculum fulfill step "${name}" not configured, capture HAR and set VINCULUM_FULFILL_ACTIONS_JSON`,
      };
    }
    const form = { ...(spec.form || {}) };
    // Interpolate {{webOrderNo}} etc.
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === 'string') {
        form[k] = v
          .replaceAll('{{webOrderNo}}', order.webOrderNo || '')
          .replaceAll('{{hcSku}}', order.hcSku || '')
          .replaceAll('{{channel}}', order.channel || '');
      }
    }
    Object.assign(form, extra);
    if (spec.binary) {
      const bin = await client.getBinary(spec.action, form);
      const ok = bin.status >= 200 && bin.status < 300 && bin.body.length > 0;
      return {
        ok,
        step: name,
        contentType: bin.contentType,
        bytes: bin.body.length,
        base64: ok ? bin.body.toString('base64') : null,
        error: ok ? null : `HTTP ${bin.status} or empty body`,
      };
    }
    const r = await client.postAction(spec.action, form);
    const ok = r.status >= 200 && r.status < 400 && !/error|fail|exception/i.test(r.text.slice(0, 500));
    return { ok, step: name, status: r.status, preview: r.text.slice(0, 200), error: ok ? null : `HTTP ${r.status}` };
  }

  async function fulfillOrder(order, { steps } = {}) {
    const sequence = steps || ['confirm', 'invoice', 'readyForShipment', 'markShipped', 'downloadLabel'];
    const results = [];
    for (const step of sequence) {
      const r = await runNamed(step, order);
      results.push(r);
      if (!r.ok && !r.skipped) break;
    }
    const hardFail = results.find((r) => !r.ok && !r.skipped);
    const anySkipped = results.some((r) => r.skipped);
    return {
      webOrderNo: order.webOrderNo,
      ok: !hardFail && !anySkipped,
      partial: !hardFail && anySkipped,
      results,
      labelBase64: results.find((r) => r.step === 'downloadLabel' && r.base64)?.base64 || null,
    };
  }

  return { fulfillOrder, runNamed, actionsConfigured: Object.keys(actions) };
}
