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

test('ewaybill.generate reads { runUid, input:{rows,dryRun} } and summarizes ok/failed', async () => {
  const { handlers, finished } = harness();
  const r = await handlers['ewaybill.generate']({ data: { runUid: 'r', input: { rows: [{ so: 'SO1' }, { so: 'SO2' }], dryRun: false } } });
  assert.equal(r.ok, 2);
  assert.equal(r.failed, 0);
  assert.equal(finished[0].res.ok, true);
});
