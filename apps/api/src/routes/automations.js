// Automation endpoints. Pattern for every automation: validate input → create Run row
// → enqueue for the worker (the only UC-talking process) → return runUid (async) or
// wait briefly for the result (sync UI actions).
import { randomUUID } from 'node:crypto';
import { createRun, finishRun, query } from '@opptra/core';
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
//
// The limiter runs in onRequest, BEFORE auth populates req.user, so we read the email
// straight from the JWT cookie payload for bucketing. No signature check is needed here
// (real auth still verifies the token later) - this only picks a stable per-user bucket.
function userBucket(req) {
  try {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)opptra_session=([^;]+)/);
    if (m) {
      const payload = decodeURIComponent(m[1]).split('.')[1];
      const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (claims.email) return `u:${claims.email}`;
    }
  } catch { /* fall through to IP */ }
  return `ip:${req.ip}`;
}
const perUser = (max, timeWindow) => ({ rateLimit: { max, timeWindow, keyGenerator: userBucket } });

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
  }, async (req) => {
    const input = req.body;
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
  }, async (req) => {
    const runs = [];
    for (const pair of req.body.pairs) {
      const input = { saleOrder: pair.correctSO, cancelSO: pair.originalSO || null, returnIn: req.body.returnIn };
      const run = await createRun({ userEmail: req.user.email, automation: 'return', action: 'process-so', input });
      await enqueue('return.process', { runUid: run.run_uid, input });
      runs.push({ saleOrder: pair.correctSO, runUid: run.run_uid });
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
                so: SO_CODE,
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
  }, async (req) => {
    const run = await createRun({
      userEmail: req.user.email, automation: 'ewaybill', action: req.body.dryRun ? 'dry-run' : 'generate',
      input: { count: req.body.rows.length, dryRun: !!req.body.dryRun },
    });
    await enqueue('ewaybill.generate', { runUid: run.run_uid, input: req.body });
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
        properties: { saleOrder: SO_CODE, channel: { type: 'string', enum: ['flipkart', 'myntra', 'zepto'] } },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'asn', action: 'compile', input: req.body });
    await enqueue('asn.compile', { runUid: run.run_uid, input: req.body });
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
          bulkReturnId: { type: 'string', minLength: 2, maxLength: 80 },
          facility: { type: 'string', minLength: 2, maxLength: 80 },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const run = await createRun({
      userEmail: req.user.email, automation: 'reversedc', action: 'from-bulk-return',
      input: { bulkReturnId: req.body.bulkReturnId, facility: req.body.facility },
    });
    await enqueue('reversedc.build', { runUid: run.run_uid, input: req.body });
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
          return reply.code(400).send({ error: 'please upload a PDF file' });
        }
        pdf = await part.toBuffer();
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (!pdf || pdf.length < 500) return reply.code(400).send({ error: 'no credit-note PDF uploaded' });

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
        properties: { saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: SO_CODE } },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'preview', input: { count: req.body.saleOrders.length } });
    await enqueue('packing.preview', { runUid: run.run_uid, userEmail: req.user.email, input: req.body });
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
          saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: SO_CODE },
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
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'drafts', input: { count: req.body.saleOrders.length } });
    await enqueue('packing.createDrafts', { runUid: run.run_uid, userEmail: req.user.email, input: req.body });
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
          saleOrders: { type: 'array', minItems: 1, maxItems: 200, items: SO_CODE },
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
  }, async (req) => {
    const run = await createRun({ userEmail: req.user.email, automation: 'packing', action: 'invoice-eway', input: { count: req.body.saleOrders.length } });
    await enqueue('packing.sendInvoiceEway', { runUid: run.run_uid, userEmail: req.user.email, input: req.body });
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
    properties: { saleOrders: { type: 'array', maxItems: 200, items: SO_CODE } },
    additionalProperties: false,
  };
  const SHEET_BODIES = { 'first-fill': SO_LIST_BODY, 'second-fill': SO_LIST_BODY };
  for (const action of ['first-fill', 'second-fill', 'push', 'sync-source']) {
    app.post(`/api/automations/sheet/${action}`, {
      preValidation: opsOnly,
      config: perUser(10, '1 minute'),
      schema: { body: SHEET_BODIES[action] || { type: 'object', properties: {}, additionalProperties: false } },
    }, async (req) => {
      const saleOrders = req.body?.saleOrders || [];
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
        properties: { saleOrder: SO_CODE }, additionalProperties: false,
      },
    },
  }, async (req) => {
    const run = await createRun({
      userEmail: req.user.email, automation: 'uc', action: 'so-status', input: req.body,
    });
    await enqueue('uc.soStatus', { runUid: run.run_uid, input: req.body });
    return { runUid: run.run_uid, queued: true };
  });

  // Poll a run's outcome (the UI polls this after enqueueing).
  app.get('/api/runs/:runUid', {
    preValidation: app.requireUser,
    schema: {
      params: { type: 'object', required: ['runUid'], properties: { runUid: { type: 'string', minLength: 8 } } },
    },
  }, async (req, reply) => {
    const { rows } = await query(
      `SELECT run_uid, user_email, automation, action, input, status, result, error,
              created_at, started_at, finished_at
       FROM runs WHERE run_uid = $1`, [req.params.runUid]);
    if (!rows.length) return reply.code(404).send({ error: 'run not found' });
    return rows[0];
  });

  // --- Home Centre (GCC): manual only. Empty order list = success. ---
  const hcBody = {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      source: { type: 'string', enum: ['active', 'archive'], default: 'active' },
      skipFulfill: { type: 'boolean', default: true },
      webOrderNos: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    },
    additionalProperties: false,
  };

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
      userEmail: req.user.email, automation: 'homecentre', action: 'sync', input,
    });
    await enqueue('homecentre.sync', { runUid: run.run_uid, input });
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
      userEmail: req.user.email, automation: 'homecentre', action: 'fulfill', input,
    });
    await enqueue('homecentre.fulfill', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });
}
