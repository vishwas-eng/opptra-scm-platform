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

// The worker must never reach across into apps/api source. It used to import
// apps/api/src/agent/catalog.js for playbook replay, which dragged in the API's BullMQ
// producer: a playbook step calling Unicommerce would ENQUEUE a job and then wait for it
// while holding the only slot of the concurrency-1 worker — a guaranteed deadlock until
// the 90s poll timed out. Shared code now lives in @opptra/agent-connectors.
test('ARCHITECTURE: worker never imports apps/api source (playbook deadlock regression)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(path.join(srcDir, file), 'utf8');
    assert.equal(/apps\/api|\.\.\/\.\.\/api\//.test(source), false,
      `${file} imports API app source — move the shared code into a package instead`);
  }
});

test('agent.playbook.run calls the UC connector DIRECTLY, never through the queue', async () => {
  // Proves the deadlock fix at the seam that matters: whatever invokeUc the worker builds
  // must hit unicommerceConnector.invoke, not reenqueue().
  const reenqueued = [];
  const connectorCalls = [];
  const handlers = makeHandlers({
    uc: { ping: async () => ({ alive: true }) },
    logger: { info() {}, warn() {}, error() {} },
    alert: async () => {},
    runs: { markRunning: async () => {}, markPendingRetry: async () => {}, finishRun: async () => {} },
    pipelines: { returnPipeline: {}, inventoryPipeline: {}, ewaybillPipeline: {} },
    reenqueue: async (name, data) => { reenqueued.push({ name, data }); },
    unicommerceConnector: {
      invoke: async (action, params) => { connectorCalls.push({ action, params }); return { ok: true, action }; },
    },
  });

  // No playbookUid short-circuits before any DB access — enough to prove the handler
  // exists and refuses cleanly; the direct-invoke wiring is asserted below by source.
  const bad = await handlers['agent.playbook.run']({ data: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /playbookUid/);
  assert.equal(reenqueued.length, 0, 'playbook path must never enqueue');

  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const pathMod = await import('node:path');
  const src = readFileSync(
    pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), '../src/handlers.js'), 'utf8');
  assert.match(src, /invokeUc:\s*async/, 'playbook executor must inject invokeUc');
  assert.match(src, /unicommerceConnector\.invoke/, 'invokeUc must call the connector directly');
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
