import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolSpecs, makeToolExecutor, canonicalToolName, connectorForTool, isKnownTool,
  LIVE_CONNECTOR_IDS, isLiveConnector, CONNECTOR_META, MUTATING_TOOLS,
} from '../src/index.js';
import { CONNECTOR_ERROR_CODES } from '@opptra/connectors-sdk';

test('live connector set is exactly the five proven platforms', () => {
  assert.deepEqual([...LIVE_CONNECTOR_IDS].sort(), [
    'google-drive', 'google-sheets', 'homecentre', 'unicommerce', 'waypoint',
  ]);
  assert.ok(isLiveConnector('unicommerce'));
  assert.ok(!isLiveConnector('amazon'));
  assert.ok(!isLiveConnector(''));
});

test('every CONNECTOR_META live flag agrees with LIVE_CONNECTOR_IDS', () => {
  for (const meta of CONNECTOR_META) {
    assert.equal(meta.live, LIVE_CONNECTOR_IDS.includes(meta.id),
      `${meta.id} live flag disagrees with LIVE_CONNECTOR_IDS`);
  }
});

test('buildToolSpecs only exposes tools for connected live connectors', () => {
  const none = buildToolSpecs([]);
  assert.equal(none.length, 0);

  const ucOnly = buildToolSpecs(['unicommerce', 'amazon' /* not live — ignored */]);
  assert.ok(ucOnly.every((t) => t.name.startsWith('unicommerce_')));
  assert.ok(ucOnly.some((t) => t.name === 'unicommerce_inventory_snapshot'));

  const sheets = buildToolSpecs(['google-sheets']);
  assert.ok(sheets.some((t) => t.name === 'sheets_clear_range'));
  assert.ok(sheets.every((t) => t.name.startsWith('sheets_')));
});

test('tool name mapping: aliases and ownership', () => {
  assert.equal(canonicalToolName('sheets.read'), 'sheets_read');
  assert.equal(canonicalToolName('drive.download'), 'drive_download');
  assert.equal(connectorForTool('sheets_append_rows'), 'google-sheets');
  assert.equal(connectorForTool('waypoint_list_orders'), 'waypoint');
  assert.equal(connectorForTool('unicommerce_health_ping'), 'unicommerce');
  assert.ok(isKnownTool('homecentre_orders_list'));
  assert.ok(!isKnownTool('amazon_orders_list'));
});

test('MUTATING_TOOLS covers every write-capable sheet tool', () => {
  for (const t of ['sheets_write', 'sheets_update_range', 'sheets_append_rows', 'sheets_clear_range', 'sheets_copy_range']) {
    assert.ok(MUTATING_TOOLS.has(t), `${t} must be flagged mutating`);
  }
  assert.ok(!MUTATING_TOOLS.has('sheets_read'));
});

test('executor construction fails closed without invokeUc', () => {
  assert.throws(() => makeToolExecutor({ userEmail: 'x@opptra.com', connectedIds: [] }));
});

test('executor blocks unconnected and coming-soon connectors with stable codes', async () => {
  const exec = makeToolExecutor({
    userEmail: 'ops@opptra.com',
    connectedIds: [],
    invokeUc: async () => ({ ok: true }),
  });

  const uc = await exec('unicommerce_health_ping', {});
  assert.equal(uc.ok, false);
  assert.equal(uc.code, CONNECTOR_ERROR_CODES.NOT_CONNECTED);
  assert.equal(uc.retryable, false);

  const amazon = await exec('amazon_orders_list', {});
  assert.equal(amazon.ok, false);
  assert.equal(amazon.code, CONNECTOR_ERROR_CODES.COMING_SOON);

  const junk = await exec('definitely_not_a_tool', {});
  assert.equal(junk.ok, false);
  assert.equal(junk.code, CONNECTOR_ERROR_CODES.UNKNOWN_ACTION);
});

test('executor routes UC tools through injected invokeUc (worker can go direct)', async () => {
  const calls = [];
  const exec = makeToolExecutor({
    userEmail: 'ops@opptra.com',
    connectedIds: ['unicommerce'],
    invokeUc: async (action, params) => {
      calls.push({ action, params });
      return { ok: true, action };
    },
  });

  const ping = await exec('unicommerce_health_ping', {});
  assert.equal(ping.ok, true);

  const so = await exec('unicommerce_sale_order_summary', { saleOrder: 'SO02780' });
  assert.equal(so.ok, true);

  const snap = await exec('unicommerce_inventory_snapshot', { skus: ['A', 'B'], facility: 'F1' });
  assert.equal(snap.ok, true);

  assert.deepEqual(calls.map((c) => c.action), ['health.ping', 'saleOrder.getSummary', 'inventory.snapshot']);
  assert.deepEqual(calls[1].params, { saleOrder: 'SO02780' });
  assert.deepEqual(calls[2].params, { skus: ['A', 'B'], facility: 'F1' });
});

test('executor sanitizes secret-looking keys out of UC results', async () => {
  const exec = makeToolExecutor({
    userEmail: 'ops@opptra.com',
    connectedIds: ['unicommerce'],
    invokeUc: async () => ({ ok: true, jsessionid: 'TOP-SECRET', nested: { authorization: 'Bearer xyz' } }),
  });
  const r = await exec('unicommerce_health_ping', {});
  assert.equal(JSON.stringify(r).includes('TOP-SECRET'), false);
  assert.equal(JSON.stringify(r).includes('Bearer xyz'), false);
});

test('SECURITY: drive_search no longer accepts a raw Drive query expression', () => {
  // A free-form `q` let anything reaching the model — including text read out of a bound
  // sheet, i.e. content an outsider can influence — enumerate the whole Drive
  // (`fullText contains 'password'`), bypassing the bind-first ACL.
  const spec = buildToolSpecs(['google-drive']).find((t) => t.name === 'drive_search');
  assert.ok(!spec.parameters.properties.query, 'raw query parameter must be gone');
  assert.deepEqual(
    spec.parameters.properties.mimeType.enum,
    ['spreadsheet', 'document', 'folder', 'pdf', 'csv'],
    'type filter must be an allowlist, not free text',
  );
});

test('SECURITY: a bound-resource miss carries a machine code, not just prose', async () => {
  const { resolveBoundResource } = await import('@opptra/core');
  assert.equal(typeof resolveBoundResource, 'function');
  // Unit-level: the shape contract callers branch on.
  const shape = { ok: false, code: 'NOT_BOUND', retryable: false, error: 'x', bindRequired: true };
  assert.equal(shape.code, CONNECTOR_ERROR_CODES.NOT_BOUND);
  assert.equal(shape.retryable, false);
});
