import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandlers } from '../src/handlers.js';

// Build handlers with fakes. This exercises the SAME job.data shape the API enqueues
// ({ runUid, input }) against the SAME destructuring the worker uses — the exact
// contract that C1 broke (inventory.run read input.form when the API sent it flat).
function harness() {
  const finished = [];
  const alerts = [];
  const pipelineCalls = [];
  const runs = {
    markRunning: async () => {},
    markPendingRetry: async () => {},
    finishRun: async (runUid, res) => finished.push({ runUid, res }),
  };
  const inventoryPipeline = {
    runInward: async (form) => { pipelineCalls.push(['inward', form]); return { status: 'INWARD_DONE', poCode: 'PO1' }; },
    runOutward: async (form) => { pipelineCalls.push(['outward', form]); return { status: 'OUTWARD_DONE', soCode: 'SO1' }; },
    runFullCycle: async (form) => { pipelineCalls.push(['fullcycle', form]); return { status: 'FULLCYCLE_DONE' }; },
  };
  const handlers = makeHandlers({
    uc: { ping: async () => ({ alive: true }) },
    logger: { info() {}, warn() {}, error() {} },
    alert: async (key, msg, detail) => alerts.push({ key, msg, detail }),
    runs,
    pipelines: {
      returnPipeline: { state: async () => ({ status: 'CREATED' }), processSO: async () => ({ ok: true, steps: {} }) },
      ewaybillPipeline: { generateOne: async (row) => ({ so: row.so, ok: true, ewb: 'EWB1' }) },
      inventoryPipeline,
    },
    reenqueue: async () => {},
  });
  return { handlers, finished, alerts, pipelineCalls };
}

test('inventory.run reads the { runUid, input:{op,reqId,form} } contract the API sends', async () => {
  const { handlers, finished, pipelineCalls } = harness();
  // EXACTLY the payload apps/api enqueues:
  const job = { data: { runUid: 'r1', input: { op: 'inward', reqId: 'req-1', form: { items: [{ sku: 'S1', quantity: 1 }] } } } };
  const result = await handlers['inventory.run'](job);
  assert.equal(result.status, 'INWARD_DONE');
  assert.deepEqual(pipelineCalls[0][0], 'inward');
  assert.equal(pipelineCalls[0][1].reqId, 'req-1');          // reqId merged into form
  assert.deepEqual(pipelineCalls[0][1].items, [{ sku: 'S1', quantity: 1 }]);
  assert.equal(finished[0].res.ok, true);
});

test('inventory.run routes outward and fullcycle by op', async () => {
  const { handlers, pipelineCalls } = harness();
  await handlers['inventory.run']({ data: { runUid: 'r', input: { op: 'outward', reqId: 'q', form: {} } } });
  await handlers['inventory.run']({ data: { runUid: 'r', input: { op: 'fullcycle', reqId: 'q', form: {} } } });
  assert.deepEqual(pipelineCalls.map((c) => c[0]), ['outward', 'fullcycle']);
});

test('inventory.run throws on an unknown op (not a silent no-op)', async () => {
  const { handlers } = harness();
  await assert.rejects(() => handlers['inventory.run']({ data: { runUid: 'r', input: { op: 'nope', reqId: 'q', form: {} } } }), /unknown inventory op/);
});

test('RELIABILITY: session death mid e-way-bill batch stops cleanly, remaining rows skipped', async () => {
  const { SessionError } = await import('@opptra/uc-client');
  const finished = [];
  const handlers = makeHandlers({
    uc: { ping: async () => ({}) },
    logger: { info() {}, warn() {}, error() {} },
    alert: async () => {},
    runs: { markRunning: async () => {}, markPendingRetry: async () => {}, finishRun: async (u, r) => finished.push(r) },
    pipelines: {
      returnPipeline: {}, inventoryPipeline: {},
      ewaybillPipeline: { generateOne: async (row) => {
        if (row.so === 'SO2') throw new SessionError('session expired'); // dies on row 2
        return { so: row.so, ok: true, ewb: 'EWB' };
      } },
    },
    reenqueue: async () => {},
  });
  const r = await handlers['ewaybill.generate']({ data: { runUid: 'r', input: { rows: [{ so: 'SO1' }, { so: 'SO2' }, { so: 'SO3' }], dryRun: false } } });
  assert.equal(r.ok, 1);          // SO1 succeeded
  assert.equal(r.failed, 2);      // SO2 died, SO3 skipped
  assert.equal(r.results.find((x) => x.so === 'SO2').error, 'session expired');
  assert.match(r.results.find((x) => x.so === 'SO3').error, /skipped/); // did NOT keep hammering UC
});

test('ewaybill.generate reads { runUid, input:{rows,dryRun} } and summarizes ok/failed', async () => {
  const { handlers, finished } = harness();
  const r = await handlers['ewaybill.generate']({ data: { runUid: 'r', input: { rows: [{ so: 'SO1' }, { so: 'SO2' }], dryRun: false } } });
  assert.equal(r.ok, 2);
  assert.equal(r.failed, 0);
  assert.equal(finished[0].res.ok, true);
});

test('connector.unicommerce.invoke reads { runUid, input:{action,params} } and finishes the Run', async () => {
  const finished = [];
  const handlers = makeHandlers({
    uc: { ping: async () => ({ alive: true }) },
    logger: { info() {}, warn() {}, error() {} },
    alert: async () => {},
    runs: { markRunning: async () => {}, markPendingRetry: async () => {}, finishRun: async (u, r) => finished.push({ u, r }) },
    pipelines: { returnPipeline: {}, inventoryPipeline: {}, ewaybillPipeline: {} },
    reenqueue: async () => {},
    unicommerceConnector: {
      invoke: async (action, params) => ({ ok: true, action, echo: params }),
    },
  });
  const r = await handlers['connector.unicommerce.invoke']({
    data: { runUid: 'run-uc-1', input: { action: 'saleOrder.getSummary', params: { saleOrder: 'SO1' } } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'saleOrder.getSummary');
  assert.equal(finished[0].u, 'run-uc-1');
  assert.equal(finished[0].r.ok, true);
});

test('soft-fail packing results populate runs.error for Admin/KPI', async () => {
  const { summarizeRunError, makeHandlers } = await import('../src/handlers.js');
  assert.match(
    summarizeRunError({
      ok: false,
      unresolved: [{ so: 'SO1', reason: 'no warehouse email for Opp_X' }],
    }),
    /SO1: no warehouse email/,
  );
  assert.match(
    summarizeRunError({
      ok: 0,
      failed: 2,
      results: [
        { so: 'A', ok: false, error: 'distance empty' },
        { so: 'B', ok: false, error: 'vehicle missing' },
      ],
    }),
    /A: distance empty/,
  );

  const finished = [];
  const handlers = makeHandlers({
    uc: { ping: async () => ({}) },
    logger: { info() {}, warn() {}, error() {} },
    alert: async () => {},
    runs: { markRunning: async () => {}, markPendingRetry: async () => {}, finishRun: async (u, r) => finished.push(r) },
    pipelines: {
      packingPipeline: {
        previewGroups: async () => ({
          ok: false,
          groups: [],
          unresolved: [{ so: 'SO9', reason: 'not found on the B2B sheet - run Sheet Update first' }],
        }),
      },
      returnPipeline: {}, inventoryPipeline: {}, ewaybillPipeline: {},
    },
    reenqueue: async () => {},
  });
  await handlers['packing.preview']({ data: { runUid: 'r', input: { saleOrders: ['SO9'] } } });
  assert.equal(finished[0].ok, false);
  assert.match(finished[0].error, /SO9: not found on the B2B sheet/);
});
