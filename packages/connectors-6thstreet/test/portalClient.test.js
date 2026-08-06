import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortalGuard } from '@opptra/connectors-sdk';
import { makeStreet6PortalClient } from '../src/portalClient.js';

/** Guard with no pacing so tests are instant; behaviour under test is the client. */
function fastGuard() {
  return createPortalGuard({
    portal: 'test-portal',
    policy: { minDelayMs: 0, jitterMs: 0 },
    sleep: async () => {},
    random: () => 0.5,
  });
}

function client(handler, opts = {}) {
  const calls = [];
  const httpFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    const r = handler(url, init, calls.length);
    return {
      status: r.status ?? 200,
      url,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
  return {
    calls,
    c: makeStreet6PortalClient({
      username: 'u', password: 'p', httpFetch, guard: fastGuard(), ...opts,
    }),
  };
}

const LOGIN_OK = { accessToken: 'AT-1', refreshToken: 'RT-1', expiresIn: 900 };

test('login exchanges credentials for a bearer and attaches it to later calls', async () => {
  const { c, calls } = client((url) => (
    url.endsWith('api/public/login')
      ? { body: LOGIN_OK }
      : { body: { profile: { seller: '6S' } } }
  ));

  const r = await c.health();
  assert.equal(r.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /api\/public\/login$/);
  assert.equal(calls[0].headers.authorization, undefined, 'login itself must not send a stale bearer');
  assert.equal(calls[1].headers.authorization, 'Bearer AT-1');
});

test('missing credentials fail with AUTH_REQUIRED and say which login is meant', async () => {
  const { c } = client(() => ({ body: {} }), { username: '', password: '' });
  const r = await c.health();
  assert.equal(r.code, 'AUTH_REQUIRED');
  assert.match(r.error, /NOT the OMS login/i);
});

test('a login response without a token is reported, not silently treated as success', async () => {
  const { c } = client(() => ({ body: { message: 'ok' } }));
  const r = await c.health();
  assert.equal(r.code, 'AUTH_REQUIRED');
  assert.match(r.error, /no accessToken/i);
});

test('a wrong password is NOT retried, even though the portal calls it a 500', async () => {
  // 6th Street answers bad credentials with HTTP 500 and the reason in the body. If the
  // guard's 5xx retry saw that, we would resubmit bad credentials repeatedly, the
  // fastest route to a locked seller account.
  let attempts = 0;
  const { c } = client(() => {
    attempts += 1;
    return { status: 500, body: { message: 'Incorrect username or password' } };
  });

  const r = await c.health();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUTH_REQUIRED', 'a credential failure is auth, not a server fault');
  assert.equal(r.retryable, false);
  assert.match(r.error, /Incorrect username or password/);
  assert.match(r.error, /lock the seller account/i, 'must warn the operator');
  assert.equal(attempts, 1, `must submit the bad password exactly once (made ${attempts})`);
});

test('a genuine 5xx with no credential wording is still retried', async () => {
  let attempts = 0;
  const { c } = client(() => {
    attempts += 1;
    return attempts === 1
      ? { status: 503, body: { message: 'upstream unavailable' } }
      : { body: LOGIN_OK };
  });
  const r = await c.health();
  assert.ok(attempts > 1, 'a real transient fault should retry');
  assert.ok(r);
});

test('a mid-flight 401 refreshes the session and retries exactly once', async () => {
  let profileHits = 0;
  const { c, calls } = client((url) => {
    if (url.endsWith('api/public/login')) return { body: LOGIN_OK };
    if (url.endsWith('api/public/refreshToken')) return { body: { accessToken: 'AT-2', expiresIn: 900 } };
    profileHits += 1;
    return profileHits === 1 ? { status: 401, body: { message: 'expired' } } : { body: { ok: true } };
  });

  const r = await c.health();
  assert.equal(r.ok, true);
  assert.equal(profileHits, 2, 'retried once, not in a loop');
  assert.equal(calls[calls.length - 1].headers.authorization, 'Bearer AT-2', 'retry used the NEW token');
});

test('inventory upload sends a Sku,Count CSV as multipart, one file, not N calls', async () => {
  let uploaded;
  const { c } = client((url, init) => {
    if (url.endsWith('api/public/login')) return { body: LOGIN_OK };
    uploaded = init.body;
    return { body: { importId: 42 } };
  });

  const r = await c.uploadInventory([
    { sku: 'A1', count: 5 },
    { sku: 'B2', count: 0 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.data.importId, 42);
  assert.ok(uploaded instanceof FormData, 'must be multipart, not a JSON body');
});

test('CSV never emits a negative or fractional count, the portal rejects both', () => {
  const { c } = client(() => ({ body: LOGIN_OK }));
  const csv = c.buildInventoryCsv([
    { sku: 'A', count: -4 }, { sku: 'B', count: 2.7 }, { sku: 'C', count: '9' },
  ]);
  assert.deepEqual(csv.split('\n'), ['Sku,Count', 'A,0', 'B,2', 'C,9']);
});

test('an empty upload is refused before any network call', async () => {
  const { c, calls } = client(() => ({ body: LOGIN_OK }));
  const r = await c.uploadInventory([]);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(calls.length, 0, 'must not even log in to upload nothing');
});

test('the guard protects the account: a 403 stops the client dead', async () => {
  const { c } = client((url) => (
    url.endsWith('api/public/login') ? { body: LOGIN_OK } : { status: 403, headers: {}, body: '' }
  ));
  const r = await c.liveInventory();
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true, 'a portal block must be reported as a block, not a generic error');
  assert.equal(r.retryable, false);
});

test('requests identify us honestly', async () => {
  const { c, calls } = client(() => ({ body: LOGIN_OK }));
  await c.health();
  assert.match(calls[0].headers['user-agent'], /OpptraSCM/);
  assert.ok(!/Mozilla/.test(calls[0].headers['user-agent']), 'no forged browser UA');
});
