// Automation endpoints. Pattern for every automation: validate input → create Run row
// → enqueue for the worker (the only UC-talking process) → return runUid (async) or
// wait briefly for the result (sync UI actions).
import { randomUUID } from 'node:crypto';
import {
  createRun, finishRun, query, config, listRuns,
  validateReverseDcInput, validateEwaybillInput, validatePackingInput,
  validateSheetSaleOrders, validateAsnInput, validateRequiredId,
  validationFailBody,
} from '@opptra/core';
import { enqueue } from '../queue.js';

const SO_CODE = { type: 'string', pattern: '^[A-Za-z0-9/_-]{2,40}$' };

const INVENTORY_ITEMS = {
  type: 'array', minItems: 1, maxItems: 100,
  items: {
    type: 'object', required: ['sku'],
    properties: {
      sku: { type: 'string', minLength: 1, maxLength: 60 },
      quantity: { type: 'number', minimum: 0 },
      unitPrice: { type: 'number', minimum: 0 },
      sellingPrice: { type: 'number', minimum: 0 },
      maxRetailPrice: { type: 'number', minimum: 0 },
      taxCode: { type: 'string', maxLength: 20 },
    },
    additionalProperties: false,
  },
};

// Per-user (not per-IP) rate limits on job-producing routes: the global HTTP limit
// doesn't stop one insider from flooding the concurrency-1 worker queue.
import { perUser } from '../plugins/rateLimitKey.js';

/** Return 400 with { ok:false, error, fieldErrors } and never create a Run / enqueue. */
function rejectInvalid(reply, result) {
  return reply.code(400).send(validationFailBody(result));
}

export default async function automationRoutes(app) {
  const opsOnly = app.requireRole('admin', 'ops');

  // --- Return + re-dispatch: process one SO (optionally cancelling the wrong one) ---
  app.post('/api/automations/return/process', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrder'],
        properties: {
          saleOrder: SO_CODE,
          cancelSO: { ...SO_CODE, nullable: true },
          awbFromSO: { ...SO_CODE, nullable: true },
          returnIn: { type: 'boolean', default: false },
          deliver: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const so = validateRequiredId(req.body.saleOrder, { field: 'saleOrder', label: 'Sale Order' });
    if (!so.ok) return rejectInvalid(reply, so);
    if (req.body.cancelSO) {
      const cancel = validateRequiredId(req.body.cancelSO, { field: 'cancelSO', label: 'Cancel SO' });
      if (!cancel.ok) return rejectInvalid(reply, cancel);
    }
    const input = { ...req.body, saleOrder: so.id };
    const run = await createRun({
      userEmail: req.user.email, automation: 'return', action: 'process-so', input,
    });
    // No jobId dedupe: the pipeline is state-based and idempotent - re-running an SO
    // reads its current UC state and only advances what's missing.
    await enqueue('return.process', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Return: batch of pairs (original SO → correct SO), sequential by design ---
  app.post('/api/automations/return/batch', {
    preValidation: opsOnly,
    config: perUser(5, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['pairs'],
        properties: {
          pairs: {
            type: 'array', minItems: 1, maxItems: 50,
            items: {
              type: 'object', required: ['correctSO'],
              properties: { originalSO: { ...SO_CODE, nullable: true }, correctSO: SO_CODE },
              additionalProperties: false,
            },
          },
          returnIn: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    for (let i = 0; i < req.body.pairs.length; i++) {
      const pair = req.body.pairs[i];
      const correct = validateRequiredId(pair.correctSO, { field: `pairs[${i}].correctSO`, label: 'Sale Order' });
      if (!correct.ok) return rejectInvalid(reply, correct);
      if (pair.originalSO) {
        const orig = validateRequiredId(pair.originalSO, { field: `pairs[${i}].originalSO`, label: 'Original SO' });
        if (!orig.ok) return rejectInvalid(reply, orig);
      }
    }
    const runs = [];
    for (const pair of req.body.pairs) {
      const input = {
        saleOrder: String(pair.correctSO).trim(),
        cancelSO: pair.originalSO ? String(pair.originalSO).trim() : null,
        returnIn: req.body.returnIn,
      };
      const run = await createRun({ userEmail: req.user.email, automation: 'return', action: 'process-so', input });
      await enqueue('return.process', { runUid: run.run_uid, input });
      runs.push({ saleOrder: input.saleOrder, runUid: run.run_uid });
    }
    return { queued: runs.length, runs };
  });

  // --- Inward / Outward / Full-cycle ---
  const inventoryOp = (extraProps = {}) => ({
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['items'],
        properties: {
          reqId: { type: 'string', maxLength: 80 }, // pass to retry idempotently; auto if omitted
          items: INVENTORY_ITEMS,
          vendorInvoiceNumber: { type: 'string', maxLength: 60 },
          vendorInvoiceDate: { type: 'string', maxLength: 40 },
          ...extraProps,
        },
        additionalProperties: false,
      },
    },
  });
  const OUTWARD_PROPS = {
    orderCode: { type: 'string', maxLength: 40 },
    customerCode: { type: 'string', maxLength: 60 }, customerName: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 20 }, email: { type: 'string', maxLength: 120 },
    addressLine1: { type: 'string', maxLength: 200 }, city: { type: 'string', maxLength: 60 },
    state: { type: 'string', maxLength: 60 }, pincode: { type: 'string', maxLength: 12 }, country: { type: 'string', maxLength: 60 },
  };

  const runInventory = (op) => async (req) => {
    const reqId = (req.body.reqId && String(req.body.reqId)) || randomUUID();
    const { reqId: _omit, ...form } = req.body;
    const run = await createRun({ userEmail: req.user.email, automation: op, action: op, input: { reqId, items: form.items } });
    // Standard job contract: always { runUid, input }. The worker reads input.{op,reqId,form}.
    await enqueue('inventory.run', { runUid: run.run_uid, input: { op, reqId, form } });
    return { runUid: run.run_uid, reqId, queued: true };
  };

  app.post('/api/automations/inward', inventoryOp(), runInventory('inward'));
  app.post('/api/automations/outward', inventoryOp(OUTWARD_PROPS), runInventory('outward'));
  app.post('/api/automations/fullcycle', inventoryOp(OUTWARD_PROPS), runInventory('fullcycle'));

  // --- E-way bill: generate for a batch of SO rows ---
  app.post('/api/automations/ewaybill/generate', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['rows'],
        properties: {
          dryRun: { type: 'boolean', default: false },
          rows: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
              type: 'object', required: ['so'],
              properties: {
                so: { type: 'string', minLength: 1, maxLength: 40 },
                gstin: { type: 'string', maxLength: 20 },
                transporterName: { type: 'string', maxLength: 120 },
                vehicleNo: { type: 'string', maxLength: 20 },
                transMode: { type: 'string', maxLength: 12 },
                distance: { type: 'string', maxLength: 10 },
                docDate: { type: 'string', maxLength: 20 },
                docNo: { type: 'string', maxLength: 40 },
                vehicleType: { type: 'string', maxLength: 30 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    // Business rules (GSTIN, Road→vehicle, per-row messages), even on dry-run.
    const checked = validateEwaybillInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { dryRun: checked.dryRun, rows: checked.rows };
    const run = await createRun({
      userEmail: req.user.email, automation: 'ewaybill', action: input.dryRun ? 'dry-run' : 'generate',
      input: { count: input.rows.length, dryRun: input.dryRun },
    });
    await enqueue('ewaybill.generate', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- ASN compile: SO → downloadable file. The marketplace is auto-detected from the
  // SO's own UC channel (channel stays accepted as an optional override for API callers).
  app.post('/api/automations/asn/compile', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrder'],
        properties: {
          saleOrder: { type: 'string', minLength: 1, maxLength: 40 },
          channel: { type: 'string', maxLength: 40 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validateAsnInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { saleOrder: checked.saleOrder, ...(checked.channel ? { channel: checked.channel } : {}) };
    const run = await createRun({ userEmail: req.user.email, automation: 'asn', action: 'compile', input });
    await enqueue('asn.compile', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Reverse DC: Bulk Return ID + warehouse → download CN from UC → clean DC PDF ---
  app.post('/api/automations/reversedc/from-bulk-return', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['bulkReturnId', 'facility'],
        properties: {
          bulkReturnId: { type: 'string', minLength: 1, maxLength: 80 },
          facility: { type: 'string', minLength: 1, maxLength: 80 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validateReverseDcInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { bulkReturnId: checked.bulkReturnId, facility: checked.facility };
    const run = await createRun({
      userEmail: req.user.email, automation: 'reversedc', action: 'from-bulk-return',
      input,
    });
    await enqueue('reversedc.build', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // Live warehouse / facility list for the Reverse DC dropdown.
  app.post('/api/automations/uc/facilities', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
    schema: { body: { type: 'object', properties: {}, additionalProperties: false } },
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'uc', action: 'facilities', input: {} });
    await enqueue('uc.facilities', { runUid: run.run_uid, input: {} });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Reverse DC fallback: upload a credit-note PDF → clean DC (parse, don't paint) ---
  app.post('/api/automations/reversedc/build', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
  }, async (req, reply) => {
    const { makeReverseDcPipeline } = await import('@opptra/automation-reversedc');
    const parts = req.parts();
    let pdf = null;
    const fields = {};
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.mimetype !== 'application/pdf' && !part.filename?.toLowerCase().endsWith('.pdf')) {
          return reply.code(400).send({
            ok: false, error: 'please upload a PDF file',
            fieldErrors: [{ field: 'file', message: 'please upload a PDF file' }],
          });
        }
        pdf = await part.toBuffer();
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (!pdf || pdf.length < 500) {
      return reply.code(400).send({
        ok: false, error: 'no credit-note PDF uploaded',
        fieldErrors: [{ field: 'file', message: 'no credit-note PDF uploaded' }],
      });
    }

    const fromLines = String(fields.from || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
    const toLines = String(fields.to || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12);

    const run = await createRun({ userEmail: req.user.email, automation: 'reversedc', action: 'build-upload', input: { file: 'upload' } });
    try {
      const pipe = makeReverseDcPipeline(null);
      const result = await pipe.buildFromUpload(pdf, { fromLines, toLines });
      await finishRun(run.run_uid, { ok: true, result: { ok: true, creditNoteNo: result.creditNoteNo } });
      return { runUid: run.run_uid, ok: true, ...result };
    } catch (err) {
      await finishRun(run.run_uid, { ok: false, error: String(err.message || err) });
      return reply.code(500).send({ error: 'could not build Delivery Challan: ' + String(err.message || err) });
    }
  });

  // --- Packing mail: SO list → preview warehouses + recipient options ---
  app.post('/api/automations/packing/preview', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrders'],
        properties: { saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 40 } } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validatePackingInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { saleOrders: checked.ids };
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'preview', input: { count: input.saleOrders.length } });
    await enqueue('packing.preview', { runUid: run.run_uid, userEmail: req.user.email, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Packing mail: SO list → per-warehouse Gmail drafts in the operator's mailbox ---
  app.post('/api/automations/packing/drafts', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrders'],
        properties: {
          saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 40 } },
          recipients: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                to: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 120 }, maxItems: 20 },
                cc: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 120 }, maxItems: 20 },
                includeFinance: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validatePackingInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { saleOrders: checked.ids, recipients: req.body.recipients || {} };
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'drafts', input: { count: input.saleOrders.length } });
    await enqueue('packing.createDrafts', { runUid: run.run_uid, userEmail: req.user.email, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Packing mail follow-up: invoice + e-way bill DRAFT into the SAME thread ---
  app.post('/api/automations/packing/invoice-eway', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrders'],
        properties: {
          saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 40 } },
          recipients: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                to: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 120 }, maxItems: 20 },
                cc: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 120 }, maxItems: 20 },
                includeFinance: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validatePackingInput(req.body);
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { saleOrders: checked.ids, recipients: req.body.recipients || {} };
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'invoice-eway', input: { count: input.saleOrders.length } });
    await enqueue('packing.sendInvoiceEway', { runUid: run.run_uid, userEmail: req.user.email, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Packing mail: dispatch a draft the operator opened and reviewed in Gmail ---
  app.post('/api/automations/packing/send-draft', {
    preValidation: opsOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['draftId'],
        properties: { draftId: { type: 'string', minLength: 1, maxLength: 200 } },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'send-draft', input: { draftId: req.body.draftId } });
    await enqueue('packing.sendDraft', { runUid: run.run_uid, userEmail: req.user.email, input: req.body });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Sheet update (A1): first-fill / second-fill / push / sync-source ---
  // Both fills optionally take SO numbers: the first to add orders Waypoint has not
  // published (resolved from Unicommerce, warehouse included), the second to enrich
  // exactly those SOs. Push and sync-source take no input.
  const SO_LIST_BODY = {
    type: 'object',
    properties: { saleOrders: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 40 } } },
    additionalProperties: false,
  };
  const SHEET_BODIES = { 'first-fill': SO_LIST_BODY, 'second-fill': SO_LIST_BODY };
  for (const action of ['first-fill', 'second-fill', 'push', 'sync-source']) {
    app.post(`/api/automations/sheet/${action}`, {
      preValidation: opsOnly,
      config: perUser(10, '1 minute'),
      schema: { body: SHEET_BODIES[action] || { type: 'object', properties: {}, additionalProperties: false } },
    }, async (req, reply) => {
      let saleOrders = [];
      if (action === 'first-fill' || action === 'second-fill') {
        const checked = validateSheetSaleOrders(req.body?.saleOrders);
        if (!checked.ok) return rejectInvalid(reply, checked);
        saleOrders = checked.ids;
      }
      const run = await createRun({
        userEmail: req.user.email, automation: 'sheet', action,
        input: saleOrders.length ? { count: saleOrders.length } : {},
      });
      await enqueue('sheet.run', { runUid: run.run_uid, input: { action, saleOrders } });
      return { runUid: run.run_uid, queued: true };
    });
  }

  // --- UC probe: read-only SO status (used by the UI before acting) ---
  // ops-only: even read probes consume the single shared UC session/worker.
  app.post('/api/automations/uc/so-status', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
    schema: {
      body: {
        type: 'object', required: ['saleOrder'],
        properties: { saleOrder: { type: 'string', minLength: 1, maxLength: 40 } }, additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const checked = validateRequiredId(req.body.saleOrder, { field: 'saleOrder', label: 'Sale Order' });
    if (!checked.ok) return rejectInvalid(reply, checked);
    const input = { saleOrder: checked.id };
    const run = await createRun({
      userEmail: req.user.email, automation: 'uc', action: 'so-status', input,
    });
    await enqueue('uc.soStatus', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // Poll a run's outcome (the UI polls this after enqueueing).
  app.get('/api/runs/:runUid', {
    preValidation: app.requireUser,
    schema: {
      params: { type: 'object', required: ['runUid'], properties: { runUid: { type: 'string', minLength: 8 } } },
    },
  }, async (req, reply) => {
    // Scope to the caller, exactly like GET /api/runs does for the list. A run's
    // `result` holds whatever the automation produced, for Agent playbooks that is the
    // contents of the owner's bound spreadsheets and Drive files, and for connector
    // invokes it is full UC order/invoice payloads. A runUid leaking into Slack (alerts
    // carry it) must not turn into another user's data for any signed-in account.
    const isAdmin = req.user.role === 'admin';
    const { rows } = await query(
      `SELECT run_uid, user_email, automation, action, input, status, result, error,
              progress, created_at, started_at, finished_at
       FROM runs
       WHERE run_uid = $1 AND ($2::text IS NULL OR user_email = $2)`,
      [req.params.runUid, isAdmin ? null : req.user.email],
    );
    // 404 rather than 403 for someone else's run: an existence oracle over run ids is
    // itself a small leak.
    if (!rows.length) return reply.code(404).send({ error: 'run not found' });
    return rows[0];
  });

  // --- Home Centre (GCC): orders→staging UC; inventory←UAE UC. HC_LIVE gates marketplace writes. ---
  const hcBody = {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      source: { type: 'string', enum: ['active', 'archive'], default: 'active' },
      skipFulfill: { type: 'boolean', default: true },
      webOrderNos: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      sellerCode: { type: 'string', maxLength: 20 },
      skus: { type: 'array', items: { type: 'string' }, maxItems: 500 },
    },
    additionalProperties: false,
  };

  app.get('/api/automations/homecentre/status', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
  }, async () => {
    const c = config();
    const recent = await listRuns({ automation: 'homecentre', limit: 15 });
    return {
      ok: true,
      ownerEmail: c.HC_OWNER_EMAIL || 'ratikanta@opptra.com',
      live: c.HC_LIVE,
      dryRunDefault: c.HC_DRY_RUN,
      ordersTarget: c.HC_ORDERS_UC_TARGET,
      syncMinutes: c.HC_SYNC_MINUTES,
      vinculumConfigured: !!(c.VINCULUM_USER && c.VINCULUM_PASS),
      staging: {
        baseUrl: c.HC_UC_STAGING_BASE_URL,
        facility: c.HC_UC_STAGING_FACILITY,
        channel: c.HC_UC_STAGING_CHANNEL,
        customer: c.HC_UC_STAGING_CUSTOMER || c.HC_CUSTOMER_CODE,
        // Staging personal/bot only, never India UC_USER / sc.automations.
        configured: !!(c.HC_UC_STAGING_USER && c.HC_UC_STAGING_PASS),
      },
      uae: {
        baseUrl: c.HC_UC_UAE_BASE_URL,
        facility: c.HC_UC_UAE_FACILITY,
        channel: c.HC_UC_UAE_CHANNEL,
        customer: c.HC_UC_UAE_CUSTOMER || c.HC_CUSTOMER_CODE,
        // Dedicated UAE bot only, never India UC_USER / sc.automations.
        configured: !!(c.HC_UC_UAE_USER || c.UC_UAE_USER)
          && !!(c.HC_UC_UAE_PASS || c.UC_UAE_PASS),
      },
      ksa: {
        instance_id: 'ksa',
        baseUrl: c.HC_UC_KSA_BASE_URL,
        facility: c.HC_UC_KSA_FACILITY,
        // Dedicated KSA bot only, never India UC_USER / sc.automations / HC_UC_USER.
        configured: !!(c.HC_UC_KSA_USER || c.UC_KSA_USER)
          && !!(c.HC_UC_KSA_PASS || c.UC_KSA_PASS),
      },
      sellerCodes: { uae: c.HC_SELLER_CODE_UAE, other: c.HC_SELLER_CODE_KSA },
      recentRuns: recent.map((r) => ({
        run_uid: r.run_uid,
        action: r.action,
        status: r.status,
        user_email: r.user_email,
        created_at: r.created_at,
        finished_at: r.finished_at,
        error: r.error,
        summary: r.result?.message || r.result?.mode || null,
        mode: r.result?.mode || null,
        dryRun: r.result?.dryRun,
        okCount: r.result?.okCount ?? r.result?.orders?.okCount,
        failed: r.result?.failed ?? r.result?.orders?.failed,
      })),
      modeLabel: c.HC_LIVE
        ? (c.HC_ORDERS_UC_TARGET === 'uae' ? 'Live UAE' : 'Live inventory / staging orders')
        : (c.HC_DRY_RUN ? 'Staging / Dry-run' : 'Staging writes (HC_LIVE=false)'),
    };
  });

  app.post('/api/automations/homecentre/sync', {
    preValidation: opsOnly,
    config: perUser(10, '1 minute'),
    schema: { body: hcBody },
  }, async (req) => {
    const input = {
      dryRun: req.body?.dryRun !== false,
      limit: req.body?.limit || 50,
      source: req.body?.source || 'active',
    };
    const run = await createRun({
      userEmail: req.user.email,
      ownerEmail: 'ratikanta@opptra.com',
      automation: 'homecentre',
      action: 'sync',
      input,
    });
    await enqueue('homecentre.sync', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  app.post('/api/automations/homecentre/inventory', {
    preValidation: opsOnly,
    config: perUser(10, '1 minute'),
    schema: { body: hcBody },
  }, async (req) => {
    const input = {
      dryRun: req.body?.dryRun !== false,
      sellerCode: req.body?.sellerCode,
      skus: req.body?.skus || null,
    };
    const run = await createRun({
      userEmail: req.user.email,
      ownerEmail: 'ratikanta@opptra.com',
      automation: 'homecentre',
      action: 'inventory',
      input,
    });
    await enqueue('homecentre.inventory', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  app.post('/api/automations/homecentre/fulfill', {
    preValidation: opsOnly,
    config: perUser(10, '1 minute'),
    schema: { body: hcBody },
  }, async (req) => {
    const input = {
      dryRun: req.body?.dryRun !== false,
      limit: req.body?.limit || 20,
      webOrderNos: req.body?.webOrderNos || null,
    };
    const run = await createRun({
      userEmail: req.user.email,
      ownerEmail: 'ratikanta@opptra.com',
      automation: 'homecentre',
      action: 'fulfill',
      input,
    });
    await enqueue('homecentre.fulfill', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- 6th Street (GCC): picklist+invoice+label → email Daniyal; inventory UC→portal secondary. ---
  const street6Body = {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', default: true },
      send: { type: 'boolean', default: false },
      orderIds: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 50 },
      skus: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 500 },
    },
    additionalProperties: false,
  };

  app.get('/api/automations/6thstreet/status', {
    preValidation: opsOnly,
    config: perUser(30, '1 minute'),
  }, async () => {
    const c = config();
    const recent = await listRuns({ automation: '6thstreet', limit: 15 });
    return {
      ok: true,
      ownerEmail: c.STREET6_OWNER_EMAIL,
      emailTo: c.STREET6_EMAIL_TO,
      live: c.STREET6_LIVE,
      dryRunDefault: c.STREET6_DRY_RUN,
      vpnConfigured: !!(c.STREET6_VPN_USER && c.STREET6_VPN_PASS && c.STREET6_VPN_HOST),
      portalConfigured: !!(c.STREET6_PORTAL_USER && c.STREET6_PORTAL_PASS),
      omsConfigured: !!(c.STREET6_OMS_USER && c.STREET6_OMS_PASS),
      ucInstance: c.STREET6_UC_INSTANCE,
      ucFacility: c.STREET6_UC_FACILITY || null,
      syncMinutes: c.STREET6_SYNC_MINUTES || 0,
      awaitingHar: true,
      primary: 'pack.email',
      secondary: 'inventory.push',
      recentRuns: recent.map((r) => ({
        run_uid: r.run_uid,
        action: r.action,
        status: r.status,
        user_email: r.user_email,
        created_at: r.created_at,
        finished_at: r.finished_at,
        error: r.error,
        summary: r.result?.message || null,
        dryRun: r.result?.dryRun,
      })),
    };
  });

  app.post('/api/automations/6thstreet/pack-email', {
    preValidation: opsOnly,
    config: perUser(10, '1 minute'),
    schema: { body: street6Body },
  }, async (req) => {
    const input = {
      dryRun: req.body?.dryRun !== false,
      send: !!req.body?.send,
      orderIds: req.body?.orderIds || [],
    };
    const run = await createRun({
      userEmail: req.user.email,
      ownerEmail: config().STREET6_OWNER_EMAIL || 'daniyal@opptra.com',
      automation: '6thstreet',
      action: 'pack-email',
      input: { ...input, orderCount: input.orderIds.length },
    });
    await enqueue('street6.packEmail', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  app.post('/api/automations/6thstreet/inventory', {
    preValidation: opsOnly,
    config: perUser(10, '1 minute'),
    schema: { body: street6Body },
  }, async (req) => {
    const input = {
      dryRun: req.body?.dryRun !== false,
      skus: req.body?.skus || null,
    };
    const run = await createRun({
      userEmail: req.user.email,
      ownerEmail: config().STREET6_OWNER_EMAIL || 'daniyal@opptra.com',
      automation: '6thstreet',
      action: 'inventory',
      input,
    });
    await enqueue('street6.inventory', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // Scheduled running jobs board (HC + 6th Street + sheet sync).
  app.get('/api/schedules', {
    preValidation: opsOnly,
    config: perUser(60, '1 minute'),
  }, async () => {
    const c = config();
    const [hcRuns, streetRuns, sheetRuns] = await Promise.all([
      listRuns({ automation: 'homecentre', limit: 5 }),
      listRuns({ automation: '6thstreet', limit: 5 }),
      listRuns({ automation: 'sheet', limit: 5 }),
    ]);
    const lastOf = (runs, actions) => {
      const hit = runs.find((r) => !actions || actions.includes(r.action));
      return hit ? {
        run_uid: hit.run_uid,
        action: hit.action,
        status: hit.status,
        created_at: hit.created_at,
        finished_at: hit.finished_at,
        error: hit.error,
        summary: hit.result?.message || null,
      } : null;
    };
    return {
      ok: true,
      jobs: [
        {
          id: 'homecentre-sync',
          name: 'Home Centre Sync',
          description: 'One job: UAE UC inventory → Vinculum + HC orders → UC (staging until live).',
          ownerEmail: c.HC_OWNER_EMAIL || 'ratikanta@opptra.com',
          everyMinutes: c.HC_SYNC_MINUTES,
          enabled: c.HC_SYNC_MINUTES > 0 && !!(c.VINCULUM_USER && c.VINCULUM_PASS),
          dryRunDefault: c.HC_DRY_RUN,
          live: c.HC_LIVE,
          steps: ['inventory (UAE UC → HC seller 75)', 'orders (HC → staging/UAE UC)'],
          lastRun: lastOf(hcRuns, ['scheduled', 'sync', 'inventory']),
        },
        {
          id: 'street6-sync',
          name: '6th Street Sync',
          description: 'One job: picklist+invoice+label email to Daniyal + UC→portal inventory.',
          ownerEmail: c.STREET6_OWNER_EMAIL || 'daniyal@opptra.com',
          everyMinutes: c.STREET6_SYNC_MINUTES || 0,
          enabled: (c.STREET6_SYNC_MINUTES || 0) > 0,
          dryRunDefault: c.STREET6_DRY_RUN,
          live: c.STREET6_LIVE,
          steps: ['pack-email (picklist + invoice + label)', 'inventory (UC → 6th Street)'],
          lastRun: lastOf(streetRuns, ['scheduled', 'pack-email', 'inventory']),
          awaitingHar: true,
        },
        {
          id: 'sheet-sync-source',
          name: 'Sheet source sync',
          description: 'Pull ops source into Master sheet.',
          ownerEmail: null,
          everyMinutes: c.SHEET_SYNC_MINUTES || 0,
          enabled: (c.SHEET_SYNC_MINUTES || 0) > 0,
          dryRunDefault: false,
          live: true,
          steps: ['sheet.syncSource'],
          lastRun: lastOf(sheetRuns, ['syncSource', 'sync']),
        },
      ],
    };
  });
}
