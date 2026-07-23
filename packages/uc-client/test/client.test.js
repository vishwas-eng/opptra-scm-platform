import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UcClient } from '../src/client.js';
import { MemorySessionStore } from '../src/store.js';
import { SessionError, UcError } from '../src/errors.js';
import { Mutex } from '../src/http.js';

const jsonRes = (body, status = 200) => ({
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

function makeClient(fetchImpl, { cookie = 'abc123', alerts = [] } = {}) {
  return new UcClient({
    baseUrl: 'https://uc.example.com',
    user: 'bot',
    pass: 'pw',
    fetchImpl,
    sessionStore: new MemorySessionStore({ jsessionid: cookie, source: 'override' }),
    alertFn: async (key, msg, detail) => { alerts.push({ key, msg, detail }); },
  });
}

test('data(): success passes through, successful:false is NOT session death', async () => {
  const calls = [];
  const client = makeClient(async (url, opts) => {
    calls.push({ url, opts });
    return jsonRes({ successful: false, message: 'wrong facility' });
  });
  const d = await client.data('/data/oms/saleorder/fetch', { code: 'SO1' });
  assert.equal(d.successful, false); // soft false returned to caller, no throw
  assert.equal(calls.length, 1);
});

test('data(): 401 → one refresh attempt → throws SessionError when no login strategy', async () => {
  const alerts = [];
  let n = 0;
  const client = makeClient(async () => { n += 1; return jsonRes({}, 401); }, { alerts });
  await assert.rejects(() => client.data('/data/x', {}), SessionError);
  assert.equal(n, 1); // no blind retry without a fresh session
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'uc-session-dead');
});

test('data(): 401 → scripted login → retried once with fresh cookie', async () => {
  const seen = [];
  let first = true;
  const client = makeClient(async (url, opts) => {
    seen.push(opts.headers.Cookie);
    if (first) { first = false; return jsonRes({}, 401); }
    return jsonRes({ successful: true, value: 42 });
  });
  client.session.loginScripted = async () => 'freshcookie';
  const d = await client.data('/data/x', {});
  assert.equal(d.value, 42);
  assert.deepEqual(seen, ['JSESSIONID=abc123', 'JSESSIONID=freshcookie']);
});

test('data(): USER_NOT_LOGGED_IN error body is treated as session death', async () => {
  const alerts = [];
  const client = makeClient(async () => jsonRes({ errors: [{ code: 'USER_NOT_LOGGED_IN' }] }), { alerts });
  await assert.rejects(() => client.data('/data/x', {}), SessionError);
});

test('data(): 403 is NOT session death (the @53 lesson)', async () => {
  const client = makeClient(async () => jsonRes({ ok: 1 }, 403));
  // 403 with a JSON body should be returned to the caller, not classified as death
  const d = await client.data('/data/x', {});
  assert.equal(d.ok, 1);
});

test('facility switch happens once per facility change and serializes', async () => {
  const paths = [];
  const client = makeClient(async (url) => {
    paths.push(new URL(url).pathname);
    return jsonRes({ successful: true });
  });
  await Promise.all([
    client.data('/data/a', {}, { facility: 'F1' }),
    client.data('/data/b', {}, { facility: 'F1' }),
    client.data('/data/c', {}, { facility: 'F2' }),
  ]);
  assert.deepEqual(paths, [
    '/data/user/switchfacility', '/data/a',
    '/data/b',
    '/data/user/switchfacility', '/data/c',
  ]);
});

test('public(): bearer fetched once, Facility header set, UcError on successful:false', async () => {
  let tokenCalls = 0;
  const client = makeClient(async (url, opts) => {
    if (url.includes('/oauth/token')) { tokenCalls += 1; return jsonRes({ access_token: 't1', expires_in: 3600 }); }
    assert.equal(opts.headers.Facility, 'FAC1');
    assert.equal(opts.headers.Authorization, 'bearer t1');
    return jsonRes({ successful: true });
  });
  await client.public('/services/rest/v1/x', {}, { facility: 'FAC1' });
  await client.public('/services/rest/v1/x', {}, { facility: 'FAC1' });
  assert.equal(tokenCalls, 1);

  const failing = makeClient(async (url) => url.includes('/oauth/token')
    ? jsonRes({ access_token: 't', expires_in: 3600 })
    : jsonRes({ successful: false, errors: [{ description: 'boom' }] }));
  await assert.rejects(() => failing.public('/x', {}), UcError);
});

test('ping(): alive on success, dead-not-thrown on session error', async () => {
  const alive = makeClient(async () => jsonRes({ currentFacilityCode: 'F9' }));
  assert.deepEqual(await alive.ping(), { alive: true, currentFacility: 'F9' });

  const dead = makeClient(async () => jsonRes({}, 401));
  const r = await dead.ping();
  assert.equal(r.alive, false);
});

test('Mutex: preserves order and survives rejections', async () => {
  const m = new Mutex();
  const order = [];
  const p1 = m.run(async () => { order.push(1); throw new Error('x'); }).catch(() => order.push('e1'));
  const p2 = m.run(async () => { order.push(2); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 'e1', 2]);
});

test('session paste: worker adopts a cookie written to the store after boot', async () => {
  const store = new MemorySessionStore({ jsessionid: '', source: 'none' }); // boot with NO cookie
  let n = 0;
  const client = new UcClient({
    baseUrl: 'https://uc.example.com', user: 'u', pass: 'p',
    sessionStore: store,
    fetchImpl: async (url, opts) => {
      n += 1;
      // succeed only when the freshly-pasted cookie is used
      return opts.headers.Cookie === 'JSESSIONID=pasted'
        ? jsonRes({ currentFacilityCode: 'F1' })
        : jsonRes({}, 401);
    },
    alertFn: async () => {},
  });
  // first ping: no cookie → dead
  assert.equal((await client.ping()).alive, false);
  // admin pastes into the store (as the API process would)
  await store.set('pasted', 'admin-paste', 'admin@opptra.com');
  // next ping reloads the store, adopts the cookie, and goes alive
  assert.deepEqual(await client.ping(), { alive: true, currentFacility: 'F1' });
});

test('hard-coded UC_JSESSIONID_OVERRIDE seeds the session on boot (ping goes alive)', async () => {
  const store = new MemorySessionStore({ jsessionid: '', source: 'none' });
  const client = new UcClient({
    baseUrl: 'https://uc.example.com', user: 'u', pass: 'p',
    overrideCookie: 'HARDCODED_TOKEN', sessionStore: store, alertFn: async () => {},
    fetchImpl: async (url, opts) => opts.headers.Cookie === 'JSESSIONID=HARDCODED_TOKEN'
      ? jsonRes({ currentFacilityCode: 'F1' }) : jsonRes({}, 401),
  });
  // First ping (keepalive) must apply the override and go alive - no admin paste needed.
  assert.deepEqual(await client.ping(), { alive: true, currentFacility: 'F1' });
});
