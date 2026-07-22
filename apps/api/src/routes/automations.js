// Automation endpoints. Pattern for every automation: validate input → create Run row
// → enqueue for the worker (the only UC-talking process) → return runUid (async) or
// wait briefly for the result (sync UI actions).
import { createRun } from '@opptra/core';
import { enqueue } from '../queue.js';

const SO_CODE = { type: 'string', pattern: '^[A-Za-z0-9/_-]{2,40}$' };

// Per-user (not per-IP) rate limits on job-producing routes: the global HTTP limit
// doesn't stop one insider from flooding the concurrency-1 worker queue.
const perUser = (max, timeWindow) => ({
  rateLimit: { max, timeWindow, keyGenerator: (req) => req.user?.email || req.ip },
});

export default async function automationRoutes(app) {
  const opsOnly = app.requireRole('admin', 'ops');

  // --- Return + re-dispatch: process one SO (optionally cancelling the wrong one) ---
  app.post('/api/automations/return/process', {
    preHandler: opsOnly,
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
    // No jobId dedupe: the pipeline is state-based and idempotent — re-running an SO
    // reads its current UC state and only advances what's missing.
    await enqueue('return.process', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true };
  });

  // --- Return: batch of pairs (original SO → correct SO), sequential by design ---
  app.post('/api/automations/return/batch', {
    preHandler: opsOnly,
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

  // --- E-way bill: generate for a batch of SO rows ---
  app.post('/api/automations/ewaybill/generate', {
    preHandler: opsOnly,
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

  // --- UC probe: read-only SO status (used by the UI before acting) ---
  // ops-only: even read probes consume the single shared UC session/worker.
  app.post('/api/automations/uc/so-status', {
    preHandler: opsOnly,
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
    preHandler: app.requireUser,
    schema: {
      params: { type: 'object', required: ['runUid'], properties: { runUid: { type: 'string', minLength: 8 } } },
    },
  }, async (req, reply) => {
    const { query } = await import('@opptra/core');
    const { rows } = await query(
      `SELECT run_uid, user_email, automation, action, input, status, result, error,
              created_at, started_at, finished_at
       FROM runs WHERE run_uid = $1`, [req.params.runUid]);
    if (!rows.length) return reply.code(404).send({ error: 'run not found' });
    return rows[0];
  });
}
