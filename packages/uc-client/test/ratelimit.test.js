import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, retryAfterMs } from '../src/ratelimit.js';
import { makeHttp } from '../src/http.js';

test('burst tokens are available immediately, then pacing kicks in', () => {
  let t = 1000;
  const rl = new RateLimiter({ rps: 10, burst: 3, now: () => t });
  // 3 burst tokens available at once
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), true);
  // bucket empty
  assert.equal(rl.tryTake(), false);
  // after 100ms at 10 rps → 1 token refilled
  t += 100;
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), false);
});

test('refill is capped at burst capacity', () => {
  let t = 0;
  const rl = new RateLimiter({ rps: 5, burst: 2, now: () => t });
  rl.tryTake(); rl.tryTake(); // drain
  t += 100_000; // long idle
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), false); // never more than `burst`
});

test('take() paces real calls (5 calls at 20rps/burst1 spans a few refill windows)', async () => {
  const rl = new RateLimiter({ rps: 20, burst: 1 });
  const start = Date.now();
  for (let i = 0; i < 5; i++) await rl.take();
  const elapsed = Date.now() - start;
  // 1 immediate + 4 paced at ~50ms each ≈ 200ms (allow slack for timer coarseness)
  assert.ok(elapsed >= 120, `expected pacing, got ${elapsed}ms`);
});

test('http honors 429 Retry-After and retries (even a POST)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { status: 429, headers: { get: (h) => (h === 'retry-after' ? '0' : null) }, json: async () => ({}) };
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };
  const http = makeHttp({ fetchImpl });
  const res = await http.request('https://x/y', { method: 'POST', idempotent: false });
  assert.equal(res.status, 200);
  assert.equal(calls, 2, '429 should have triggered exactly one retry');
});

test('retryAfterMs parses seconds and caps', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('120', 60_000), 60_000); // capped
  assert.equal(retryAfterMs(null), null);
});
