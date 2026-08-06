import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResult } from '../src/index.js';

test('secret-looking KEYS are redacted at any depth', () => {
  const r = sanitizeResult({
    jsessionid: 'X', nested: { authorization: 'Y', apiKey: 'Z', deep: { refresh_token: 'W' } },
  });
  assert.equal(r.jsessionid, '[redacted]');
  assert.equal(r.nested.authorization, '[redacted]');
  assert.equal(r.nested.apiKey, '[redacted]');
  assert.equal(r.nested.deep.refresh_token, '[redacted]');
});

test('secret-looking VALUES are redacted even under innocuous keys', () => {
  // The real leak path: an upstream portal puts a cookie in a message string, and the
  // key is something bland like `note` that no key-name filter would ever catch.
  assert.equal(sanitizeResult({ note: 'JSESSIONID=ABC123DEF; Path=/' }).note, '[redacted]; Path=/');
  assert.match(sanitizeResult({ msg: 'Authorization: bearer eyJraWQiOiJzb21ldGhpbmcifQ' }).msg, /\[redacted\]/);
  assert.match(sanitizeResult({ m: 'token 1//0gLongRefreshTokenValueHere12345' }).m, /\[redacted\]/);
  const jwt = sanitizeResult({ blob: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0' });
  assert.match(jwt.blob, /\[redacted\]/);
});

test('ordinary data is untouched, scrubbing must not corrupt real values', () => {
  const r = sanitizeResult({ ok: true, saleOrder: 'SO02780', qty: 12, city: 'Bengaluru', empty: null });
  assert.deepEqual(r, { ok: true, saleOrder: 'SO02780', qty: 12, city: 'Bengaluru', empty: null });
});

test('a realistic 50-row result keeps ok AND its data (the 4KB-blob regression)', () => {
  // Before: anything over 4 KB collapsed to { truncated, preview }, `ok` vanished, so
  // `result.ok !== false` passed while the caller got no data at all.
  const orders = Array.from({ length: 50 }, (_, i) => ({
    'SO Code': `SO000${i}`, 'SO Status': 'PROCESSING', Warehouse: 'Opp_RSG_MH',
    Customer: `CUST_LONG_CODE_${i}`, 'Brand(s)': 'BrandA,BrandB', 'Total Units': 120,
  }));
  const r = sanitizeResult({ ok: true, count: 50, orders });
  assert.equal(r.ok, true);
  assert.equal(r.orders.length, 50);
  assert.equal(r.truncated, undefined);
});

test('oversized results shrink their arrays but never lose control fields', () => {
  const huge = Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(400) }));
  const r = sanitizeResult({ ok: true, code: 'FINE', rows: huge });
  assert.equal(r.ok, true, 'ok must survive truncation');
  assert.equal(r.code, 'FINE');
  assert.equal(r.truncated, true);
  assert.ok(r.rows.length > 0 && r.rows.length < 200, `kept ${r.rows.length} rows`);
  assert.ok(JSON.stringify(r).length <= 13000);
});

test('a failed result keeps its error taxonomy through truncation', () => {
  const r = sanitizeResult({
    ok: false, code: 'RATE_LIMITED', error: 'slow down', retryable: true,
    rows: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'y'.repeat(200) })),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RATE_LIMITED');
  assert.equal(r.retryable, true);
});

test('cyclic input does not blow the stack (used to throw RangeError out of a tool)', () => {
  const a = { ok: true };
  a.self = a;
  const r = sanitizeResult(a);
  assert.equal(r.ok, true);
  assert.equal(r.self, '[circular]');
});

test('array cap is generous enough for the tools that promise 80 rows', () => {
  const r = sanitizeResult({ ok: true, values: Array.from({ length: 80 }, (_, i) => [`r${i}`]) });
  assert.equal(r.values.length, 80);
  // …but still capped, so an unbounded upstream list cannot flood the context.
  const capped = sanitizeResult({ ok: true, values: Array.from({ length: 5000 }, (_, i) => i) });
  assert.equal(capped.values.length, 200);
});

test('numeric second arg still means maxChars (back-compat with old callers)', () => {
  const r = sanitizeResult({ ok: true, rows: Array.from({ length: 100 }, (_, i) => ({ i, pad: 'z'.repeat(100) })) }, 2000);
  assert.equal(r.ok, true);
  assert.ok(JSON.stringify(r).length <= 3000);
});

test('counters are corrected when their array is shrunk (no phantom rows)', () => {
  // Before: `count: 50` sat next to 25 surviving rows, so the model confidently reasoned
  // over 25 orders it could not see.
  const orders = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'q'.repeat(600) }));
  const r = sanitizeResult({ ok: true, count: 50, limit: 50, orders });
  assert.equal(r.truncated, true);
  assert.equal(r.count, r.orders.length, 'count must match what was actually returned');
  assert.equal(r.droppedItems.orders.total, 50);
  assert.equal(r.droppedItems.orders.returned, r.orders.length);
  assert.ok(r.truncationNote.includes('narrower'));
});
