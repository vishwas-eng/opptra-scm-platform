import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, createConnectorShell } from '../src/index.js';

const numericSchema = {
  type: 'object',
  properties: { qty: { type: 'integer', minimum: 1, maximum: 100 } },
  required: ['qty'],
  additionalProperties: false,
};

function shellWith(defs, opts = {}) {
  const registry = createRegistry();
  for (const d of defs) registry.register(d);
  return createConnectorShell({ id: 'test', name: 'Test', auth: {}, registry, ...opts });
}

test('registries are isolated — one connector cannot see another\'s actions', () => {
  const a = createRegistry();
  const b = createRegistry();
  a.register({ id: 'x', handler: async () => ({ ok: true }) });
  assert.ok(a.getAction('x'));
  assert.equal(b.getAction('x'), null);
});

test('duplicate ids and malformed defs are rejected at registration', () => {
  const r = createRegistry();
  r.register({ id: 'x', handler: async () => ({ ok: true }) });
  assert.throws(() => r.register({ id: 'x', handler: async () => ({}) }), /duplicate action id/);
  assert.throws(() => r.register({ id: 'y' }), /requires id and handler/);
  assert.throws(() => r.register({ handler: async () => ({}) }), /requires id and handler/);
});

test('an unparseable inputSchema fails at registration, not on a live call', () => {
  const r = createRegistry();
  assert.throws(() => r.register({
    id: 'bad', inputSchema: { type: 'not-a-type' }, handler: async () => ({ ok: true }),
  }));
});

test('listRegisteredActions exposes metadata but never the handler or compiled validator', () => {
  const r = createRegistry();
  r.register({ id: 'x', title: 'X', mutates: true, inputSchema: numericSchema, handler: async () => ({}) });
  const [a] = r.listRegisteredActions();
  assert.equal(a.id, 'x');
  assert.equal(a.mutates, true);
  assert.deepEqual(a.inputSchema, numericSchema);
  assert.equal(a.handler, undefined);
  assert.equal(a.validate, undefined);
});

test('invalid params are refused BEFORE the handler runs — nothing reaches the vendor', async () => {
  let called = false;
  const shell = shellWith([{
    id: 'ship', inputSchema: numericSchema, handler: async () => { called = true; return { ok: true }; },
  }]);

  const missing = await shell.invoke('ship', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_INPUT');
  assert.equal(missing.retryable, false, 'a bad payload never becomes valid by retrying it');
  assert.ok(missing.validationErrors.length);

  const outOfRange = await shell.invoke('ship', { qty: 5000 });
  assert.equal(outOfRange.code, 'INVALID_INPUT');

  const unknownField = await shell.invoke('ship', { qty: 1, facility: 'OTHER_WH' });
  assert.equal(unknownField.code, 'INVALID_INPUT', 'additionalProperties:false must block session-repinning fields');

  assert.equal(called, false, 'handler must not run for any invalid payload');
  assert.equal((await shell.invoke('ship', { qty: 1 })).ok, true);
  assert.equal(called, true);
});

test('actions with no declared schema still accept ordinary payloads', async () => {
  const shell = shellWith([{ id: 'free', handler: async (p) => ({ ok: true, got: p }) }]);
  const r = await shell.invoke('free', { anything: 'goes', n: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.got, { anything: 'goes', n: 3 });
});

test('unknown actions, awaitingHar gating and dryRun keep their precedence', async () => {
  const shell = shellWith([
    { id: 'soon', awaitingHar: true, inputSchema: numericSchema, handler: async () => ({ ok: true }) },
    { id: 'write', mutates: true, inputSchema: numericSchema, handler: async () => ({ ok: true, wrote: true }) },
  ]);

  assert.equal((await shell.invoke('nope')).code, 'UNKNOWN_ACTION');

  // awaitingHar outranks validation: the action cannot run at all, so "not live yet" is
  // the more useful answer than "your params are wrong".
  const soon = await shell.invoke('soon', {});
  assert.equal(soon.code, 'AWAITING_HAR');
  assert.equal(soon.awaitingHar, true);

  // ...but a dryRun must still validate, or preview would bless a payload the real call rejects.
  assert.equal((await shell.invoke('write', {}, { dryRun: true })).code, 'INVALID_INPUT');
  const preview = await shell.invoke('write', { qty: 2 }, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wrote, undefined, 'dryRun must not execute a mutating handler');
});

test('validateParams reports unknown actions rather than passing them through', () => {
  const r = createRegistry();
  const v = r.validateParams('ghost', {});
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /unknown action/);
});

test('beforeInvoke runs first, so a connector can refuse before any registry work', async () => {
  const seen = [];
  const shell = shellWith([{ id: 'x', handler: async () => ({ ok: true }) }], {
    beforeInvoke: (action) => { seen.push(action); },
  });
  await shell.invoke('x', {});
  await shell.invoke('unknown-one', {});
  assert.deepEqual(seen, ['x', 'unknown-one']);
});
