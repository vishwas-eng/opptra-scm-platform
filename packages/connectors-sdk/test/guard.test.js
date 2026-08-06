import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPortalGuard, detectBlock, retryAfterMs, BLOCK_SIGNALS, DEFAULT_POLICY,
} from '../src/guard.js';

/** Deterministic harness: virtual clock, instant sleeps, fixed randomness. */
function harness(policy = {}) {
  let clock = 1_000_000;
  const slept = [];
  const alerts = [];
  const guard = createPortalGuard({
    portal: 'testportal',
    policy,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    random: () => 0.5,
    onAlert: (a) => alerts.push(a),
  });
  return { guard, slept, alerts, tick: (ms) => { clock += ms; }, clockNow: () => clock };
}

const okRes = (over = {}) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}', ...over });

/* ------------------------------ detection ------------------------------ */

test('block detection recognises each pushback signal', () => {
  assert.equal(detectBlock({ status: 429 }), BLOCK_SIGNALS.RATE_LIMITED);
  assert.equal(detectBlock({ status: 403 }), BLOCK_SIGNALS.FORBIDDEN);
  assert.equal(detectBlock({
    status: 200, headers: { 'content-type': 'text/html' }, body: '<h1>Please verify you are human</h1>',
  }), BLOCK_SIGNALS.CAPTCHA);
  assert.equal(detectBlock({
    status: 200, requestUrl: 'https://p.com/api/orders', finalUrl: 'https://p.com/login?next=/api/orders',
    headers: { 'content-type': 'text/html' },
  }), BLOCK_SIGNALS.LOGIN_REDIRECT);
  assert.equal(detectBlock({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }), null);
});

test('a JSON payload containing the word captcha is NOT a block', () => {
  // A product title or field name must never trip the breaker, that would halt a
  // healthy connector on a data coincidence.
  const signal = detectBlock({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"rows":[{"name":"captcha solving service","qty":2}]}',
  });
  assert.equal(signal, null);
});

test('Retry-After is honoured in both seconds and HTTP-date form, and capped', () => {
  const now = () => 1_700_000_000_000;
  assert.equal(retryAfterMs({ 'retry-after': '30' }), 30_000);
  assert.equal(retryAfterMs({ 'Retry-After': '5' }), 5_000);
  assert.equal(retryAfterMs({ 'retry-after': new Date(1_700_000_060_000).toUTCString() }, { now }), 60_000);
  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }), null);
  // A hostile or broken header must not park the worker for a day.
  assert.equal(retryAfterMs({ 'retry-after': '999999' }), DEFAULT_POLICY.maxRetryAfterMs);
});

/* ------------------------------- pacing ------------------------------- */

test('requests are paced with jitter and never run concurrently', async () => {
  const { guard, slept } = harness({ minDelayMs: 1000, jitterMs: 400 });
  const order = [];
  const make = (id) => guard.run(async () => {
    order.push(`start-${id}`);
    return okRes();
  });

  await Promise.all([make(1), make(2), make(3)]);
  assert.deepEqual(order, ['start-1', 'start-2', 'start-3'], 'calls must serialize');
  // The first call does not pace, there is no previous request to space away from.
  // Each later one waits minDelay + jitter; with random()=0.5 that is 1000 + 200.
  assert.deepEqual(slept, [1200, 1200]);
});

test('a rejected call does not wedge the queue behind it', async () => {
  const { guard } = harness({ minDelayMs: 0, jitterMs: 0 });
  const first = guard.run(async () => { throw new Error('socket died'); });
  const second = guard.run(async () => okRes({ body: '{"second":true}' }));
  await first;
  const r = await second;
  assert.equal(r.ok, true, 'later calls must still run after an earlier failure');
});

/* ------------------------------ pushback ------------------------------ */

test('429 waits exactly the Retry-After the server asked for', async () => {
  const { guard, slept } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 1 });
  let calls = 0;
  const r = await guard.run(async () => {
    calls += 1;
    return calls === 1
      ? { status: 429, headers: { 'retry-after': '7' }, body: '' }
      : okRes();
  });
  assert.equal(r.ok, true);
  assert.ok(slept.includes(7000), `expected a 7s wait, got ${slept}`);
  assert.equal(calls, 2);
});

test('403 and CAPTCHA stop immediately, retrying into a block is what causes bans', async () => {
  for (const res of [
    { status: 403, headers: {}, body: '' },
    { status: 200, headers: { 'content-type': 'text/html' }, body: 'unusual traffic detected' },
  ]) {
    const { guard } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 3 });
    let calls = 0;
    const r = await guard.run(async () => { calls += 1; return res; });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.equal(r.retryable, false);
    assert.equal(calls, 1, 'must not retry a block signal');
  }
});

test('5xx retries with full-jitter exponential backoff, then reports upstream failure', async () => {
  const { guard, slept } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 2, transientBaseMs: 1000 });
  let calls = 0;
  const r = await guard.run(async () => { calls += 1; return { status: 503, headers: {}, body: '' }; });
  assert.equal(calls, 3, 'initial attempt plus two retries');
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.equal(r.retryable, true);
  // Full jitter = random() × window, window doubling: 1000→500, 2000→1000 at random()=0.5
  assert.deepEqual(slept, [500, 1000]);
});

test('throttling waits far longer than a transient fault at the same attempt number', async () => {
  // A 429 means the service actively rejected us; retrying on the transient timescale
  // deepens the throttle instead of clearing it.
  const opts = { minDelayMs: 0, jitterMs: 0, maxRetries: 1, transientBaseMs: 50, throttleBaseMs: 1000 };

  const t = harness(opts);
  let n = 0;
  await t.guard.run(async () => (n++ === 0 ? { status: 500, headers: {}, body: '' } : okRes()));

  const th = harness(opts);
  let m = 0;
  await th.guard.run(async () => (m++ === 0 ? { status: 429, headers: {}, body: '' } : okRes()));

  assert.ok(th.slept[0] > t.slept[0] * 10, `throttle wait ${th.slept[0]} should dwarf transient ${t.slept[0]}`);
});

test('the retry quota makes a sustained outage fail fast instead of multiplying our traffic', async () => {
  // 3 tokens, 14 per transient retry → the very first retry is unaffordable.
  const { guard } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 5, retryQuota: 3 });
  let calls = 0;
  const r = await guard.run(async () => { calls += 1; return { status: 503, headers: {}, body: '' }; });
  assert.equal(calls, 1, 'with no tokens to spend, do not retry at all');
  assert.equal(r.code, 'UPSTREAM_ERROR');
});

test('successes refund retry tokens, so an occasional blip never exhausts the quota', async () => {
  const { guard } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 1, retryQuota: 100, transientRetryCost: 10, retryRefund: 10 });
  const before = guard.status().retryTokens;
  let n = 0;
  await guard.run(async () => (n++ === 0 ? { status: 500, headers: {}, body: '' } : okRes()));
  // Spent 10 on the retry, refunded 10 on the eventual success.
  assert.equal(guard.status().retryTokens, before);
});

/* --------------------------- circuit breaker --------------------------- */

test('repeated blocks open the circuit and every later call is refused without touching the portal', async () => {
  const { guard, alerts } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 0, breakerThreshold: 2 });
  const blocked = async () => ({ status: 403, headers: {}, body: '' });

  await guard.run(blocked);
  assert.equal(guard.status().breakerOpen, false, 'one block is not yet a pattern');
  await guard.run(blocked);
  assert.equal(guard.status().breakerOpen, true);

  let reached = false;
  const r = await guard.run(async () => { reached = true; return okRes(); });
  assert.equal(reached, false, 'an open circuit must make NO network call');
  assert.equal(r.blocked, true);
  assert.match(r.error, /operator must/i);
  assert.ok(alerts.some((a) => a.breakerOpen), 'a human must be alerted');
});

test('a success between blocks resets the streak, transient noise must not trip the breaker', async () => {
  const { guard } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 0, breakerThreshold: 3 });
  await guard.run(async () => ({ status: 403, headers: {}, body: '' }));
  await guard.run(async () => okRes());
  await guard.run(async () => ({ status: 403, headers: {}, body: '' }));
  assert.equal(guard.status().consecutiveBlocks, 1);
  assert.equal(guard.status().breakerOpen, false);
});

test('the breaker only clears by explicit operator reset, never on its own', async () => {
  const { guard, tick } = harness({ minDelayMs: 0, jitterMs: 0, maxRetries: 0, breakerThreshold: 1 });
  await guard.run(async () => ({ status: 403, headers: {}, body: '' }));
  assert.equal(guard.status().breakerOpen, true);

  tick(24 * 3600 * 1000); // a whole day passes
  const stillBlocked = await guard.run(async () => okRes());
  assert.equal(stillBlocked.blocked, true, 'time alone must not resume traffic');

  guard.reset();
  assert.equal(guard.status().breakerOpen, false);
  assert.equal((await guard.run(async () => okRes())).ok, true);
});

/* ------------------------------- budget ------------------------------- */

test('the daily budget caps a runaway loop and refills on a rolling window', async () => {
  const { guard, tick } = harness({ minDelayMs: 0, jitterMs: 0, dailyBudget: 2 });
  assert.equal((await guard.run(async () => okRes())).ok, true);
  assert.equal((await guard.run(async () => okRes())).ok, true);

  const over = await guard.run(async () => okRes());
  assert.equal(over.code, 'RATE_LIMITED');
  assert.match(over.error, /budget/i);
  assert.equal(guard.status().budgetRemaining, 0);

  tick(86_400_001);
  assert.equal((await guard.run(async () => okRes())).ok, true, 'budget refills after 24h');
});

test('defaults are conservative, a connector must opt in to being noisy', () => {
  assert.ok(DEFAULT_POLICY.minDelayMs >= 500);
  assert.equal(DEFAULT_POLICY.maxConcurrent, 1);
  assert.ok(DEFAULT_POLICY.breakerThreshold <= 3);
});
