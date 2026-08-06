import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCapture, detectAuth, templatizePath, shapeOf,
  redactEntry, redactHeaders, redactBody, redactUrl, extractSessionMaterial,
  harToEntries,
} from '../src/index.js';

const SESSION_COOKIE = 'JSESSIONID=ABC123SECRET; locale=en_IN';

function entry(over = {}) {
  return {
    method: 'GET',
    url: 'https://seller.example.com/api/orders',
    status: 200,
    resourceType: 'xmlhttprequest',
    requestHeaders: { cookie: SESSION_COOKIE, 'content-type': 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: null,
    responseBody: JSON.stringify({ orders: [{ id: 1, sku: 'A' }], total: 1 }),
    ...over,
  };
}

/* ------------------------------- redaction ------------------------------- */

test('secret headers are blanked but their NAMES survive, names are the RE signal', () => {
  const h = redactHeaders({ Cookie: SESSION_COOKIE, 'X-CSRF-Token': 'tok', 'Content-Type': 'application/json' });
  assert.equal(h.cookie, '[redacted]');
  assert.equal(h['x-csrf-token'], '[redacted]');
  assert.equal(h['content-type'], 'application/json', 'structural headers must be kept verbatim');
});

test('JSON bodies keep their shape while secret-ish leaves are dropped', () => {
  const body = redactBody(JSON.stringify({
    userName: 'ops', password: 'hunter2', data: { sessionToken: 'x', rows: [{ sku: 'A', qty: 3 }] },
  }));
  assert.equal(body.userName, 'ops');
  assert.equal(body.password, '[redacted]');
  assert.equal(body.data.sessionToken, '[redacted]');
  assert.deepEqual(body.data.rows, [{ sku: 'A', qty: 3 }], 'business data must survive intact');
});

test('secret-shaped values are scrubbed even under innocent keys', () => {
  assert.match(redactBody(JSON.stringify({ note: 'JSESSIONID=ABC123DEF456' })).note, /\[redacted\]/);
  assert.match(redactUrl('https://x.com/a?sid=abc&auth_token=zzz&page=2'), /auth_token=%5Bredacted%5D/);
  assert.match(redactUrl('https://x.com/a?page=2'), /page=2/);
});

test('a non-JSON body is scrubbed and truncated, never dropped silently', () => {
  const long = redactBody(`x`.repeat(50) + ' bearer eyJhbGciOiJIUzI1NiJ9abcdefghij', { maxChars: 200 });
  assert.match(long, /\[redacted\]/);
});

test('redactEntry produces a fully safe record', () => {
  const safe = redactEntry(entry({ requestBody: JSON.stringify({ password: 'p' }) }));
  assert.equal(safe.requestHeaders.cookie, '[redacted]');
  assert.equal(safe.requestBody.password, '[redacted]');
  assert.ok(!JSON.stringify(safe).includes('ABC123SECRET'));
});

test('session material is extracted BEFORE redaction so the vault gets a usable cookie', () => {
  const mat = extractSessionMaterial([
    entry(),
    entry({
      requestHeaders: { authorization: 'Bearer abc.def.ghi' },
      responseHeaders: { 'set-cookie': ['XSRF=tok; Path=/', 'JSESSIONID=NEWER; HttpOnly'] },
    }),
  ]);
  assert.equal(mat.cookies.JSESSIONID, 'NEWER', 'the freshest Set-Cookie wins');
  assert.equal(mat.cookies.XSRF, 'tok');
  assert.match(mat.cookieHeader, /JSESSIONID=NEWER/);
  assert.deepEqual(mat.bearers, ['abc.def.ghi']);
});

/* ------------------------------- analysis ------------------------------- */

test('path templating collapses identifiers but keeps route names', () => {
  assert.equal(templatizePath('/api/v1/orders/12345/items'), '/api/v1/orders/{id}/items');
  assert.equal(templatizePath('/o/3fa85f64-5717-4562-b3fc-2c963f66afa6'), '/o/{uuid}');
  assert.equal(templatizePath('/order/SO02696123/detail'), '/order/{code}/detail');
  assert.equal(templatizePath('/api/inventory'), '/api/inventory');
});

test('shapeOf describes structure without leaking values', () => {
  const s = shapeOf({ total: 2, rows: [{ sku: 'ABC', qty: 3 }], ok: true, when: null });
  assert.deepEqual(s, {
    total: 'number',
    // The row schema must survive nesting, this is the payload a connector author maps.
    rows: { array: { sku: 'string', qty: 'number' } },
    ok: 'boolean',
    when: 'null',
  });
  assert.deepEqual(shapeOf([]), { array: 'empty' });
  assert.ok(!JSON.stringify(s).includes('ABC'), 'no data values in a shape');
});

test('analysis separates the API host from assets and analytics noise', () => {
  const res = analyzeCapture([
    entry(),
    entry({ url: 'https://seller.example.com/api/inventory' }),
    entry({ url: 'https://cdn.example.com/app.js', resourceType: 'script', responseHeaders: { 'content-type': 'application/javascript' } }),
    entry({ url: 'https://www.google-analytics.com/collect', resourceType: 'xmlhttprequest' }),
    entry({ url: 'https://seller.example.com/static/logo.png', resourceType: 'image' }),
  ]);
  assert.equal(res.summary.primaryHost, 'seller.example.com');
  assert.equal(res.summary.endpoints, 2, 'only the two JSON APIs count');
  assert.ok(!res.endpoints.some((e) => e.path.includes('logo')));
  assert.ok(!res.endpoints.some((e) => e.host.includes('google-analytics')));
});

test('repeated calls to one endpoint collapse into a single record with counts', () => {
  const res = analyzeCapture([
    entry({ url: 'https://s.com/api/orders/1' }),
    entry({ url: 'https://s.com/api/orders/2' }),
    entry({ url: 'https://s.com/api/orders/3', status: 500 }),
  ]);
  assert.equal(res.endpoints.length, 1);
  assert.equal(res.endpoints[0].path, '/api/orders/{id}');
  assert.equal(res.endpoints[0].calls, 3);
  assert.deepEqual(res.endpoints[0].statuses, { 200: 2, 500: 1 });
});

test('query keys and payload shapes are captured for the client generator', () => {
  const res = analyzeCapture([
    entry({
      method: 'POST',
      url: 'https://s.com/api/search?page=1&size=50',
      requestBody: JSON.stringify({ status: 'NEW', from: '2026-01-01' }),
      responseBody: JSON.stringify({ rows: [{ id: 1 }], total: 1 }),
    }),
  ]);
  const ep = res.endpoints[0];
  assert.deepEqual(ep.queryKeys, ['page', 'size']);
  assert.deepEqual(ep.requestShape, { status: 'string', from: 'string' });
  assert.equal(ep.responseShape.total, 'number');
});

test('auth detection names the session cookie, bearer use and custom headers', () => {
  const auth = detectAuth([
    entry(),
    entry({ requestHeaders: { cookie: SESSION_COOKIE, 'x-csrf-token': 't', 'x-tenant-id': 'opptra' } }),
    entry({ method: 'POST', url: 'https://s.com/auth/login', requestHeaders: { authorization: 'Bearer z' } }),
  ]);
  assert.equal(auth.sessionCookie, 'JSESSIONID', 'the most-seen cookie is the session');
  assert.equal(auth.bearer, true);
  assert.ok(auth.customHeaders.some((h) => h.name === 'x-tenant-id'));
  assert.equal(auth.loginRequest.path, '/auth/login');
});

test('endpoints are mapped to candidate connector actions', () => {
  const res = analyzeCapture([
    entry({ url: 'https://s.com/api/seller/orders/list' }),
    entry({ url: 'https://s.com/api/inventory/stock' }),
    entry({ url: 'https://s.com/api/shipment/manifest' }),
    entry({ url: 'https://s.com/api/misc/settings' }),
  ]);
  const actions = res.suggestedActions.map((a) => a.action);
  assert.ok(actions.includes('orders.search'));
  assert.ok(actions.includes('inventory.get'));
  assert.ok(actions.includes('shipments.search'));
  assert.ok(!actions.includes(null));
});

test('static JSON (i18n, manifests, asset bundles) never counts as an API endpoint', () => {
  const res = analyzeCapture([
    entry({ url: 'https://cdn.example.com/assets/i18n/bulkReturns/en-US.json' }),
    entry({ url: 'https://portal.example.com/manifest.json' }),
    entry({ url: 'https://cdn.example.com/resource/resource.json' }),
    entry({ url: 'https://portal.example.com/data/orders/search' }),
  ]);
  assert.equal(res.summary.endpoints, 1, 'only the real API survives');
  assert.equal(res.endpoints[0].path, '/data/orders/search');
});

test('a sanitized capture (no cookies at all) warns instead of silently yielding no session', () => {
  const auth = detectAuth([entry({ requestHeaders: { 'content-type': 'application/json' } })]);
  assert.equal(auth.sessionCookie, null);
  assert.match(auth.warning, /sanitized HAR/);
  assert.equal(detectAuth([entry()]).warning, null, 'a real capture must not warn');
});

test('HAR cookie arrays are folded back into headers (Chrome keeps them there)', () => {
  const entries = harToEntries({
    log: { entries: [{
      request: {
        method: 'GET', url: 'https://p.com/api/x', headers: [{ name: ':authority', value: 'p.com' }],
        cookies: [{ name: 'JSESSIONID', value: 'FROM-ARRAY' }, { name: 'locale', value: 'en' }],
      },
      response: { status: 200, headers: [], cookies: [{ name: 'XSRF', value: 'zz' }], content: { text: '{}' } },
    }] },
  });
  assert.equal(entries[0].requestHeaders[':authority'], undefined, 'HTTP/2 pseudo-headers are framing, not headers');
  assert.match(entries[0].requestHeaders.cookie, /JSESSIONID=FROM-ARRAY/);
  assert.equal(extractSessionMaterial(entries).cookies.JSESSIONID, 'FROM-ARRAY');
  assert.equal(extractSessionMaterial(entries).cookies.XSRF, 'zz');
});

test('malformed URLs are counted, not crashed on', () => {
  const res = analyzeCapture([entry({ url: 'not a url' }), entry()]);
  assert.equal(res.summary.unparseableUrls, 1);
  assert.equal(res.summary.endpoints, 1);
});

/* --------------------------------- HAR --------------------------------- */

test('a DevTools HAR converts to entries the analyzer understands', () => {
  const har = {
    log: {
      entries: [{
        startedDateTime: '2026-08-06T10:00:00Z',
        time: 120.7,
        _resourceType: 'xhr',
        request: {
          method: 'POST',
          url: 'https://portal.example.com/api/orders/search?page=1',
          headers: [{ name: 'Cookie', value: SESSION_COOKIE }, { name: 'Content-Type', value: 'application/json' }],
          postData: { text: '{"status":"NEW"}' },
        },
        response: {
          status: 200,
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Set-Cookie', value: 'JSESSIONID=FRESH; Path=/' },
            { name: 'Set-Cookie', value: 'XSRF=abc' },
          ],
          content: { text: '{"rows":[],"total":0}' },
        },
      }],
    },
  };
  const entries = harToEntries(har);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].durationMs, 121);
  assert.deepEqual(entries[0].responseHeaders['set-cookie'], ['JSESSIONID=FRESH; Path=/', 'XSRF=abc'],
    'repeated headers must not overwrite each other, Set-Cookie is how sessions are born');

  const res = analyzeCapture(entries);
  assert.equal(res.summary.primaryHost, 'portal.example.com');
  assert.equal(res.endpoints[0].method, 'POST');
  assert.deepEqual(res.endpoints[0].requestShape, { status: 'string' });
  assert.equal(extractSessionMaterial(entries).cookies.JSESSIONID, 'FRESH');
});

test('base64 response bodies are skipped rather than parsed as garbage', () => {
  const entries = harToEntries({
    log: { entries: [{
      request: { method: 'GET', url: 'https://x.com/a.pdf', headers: [] },
      response: { status: 200, headers: [], content: { encoding: 'base64', text: 'JVBERi0xLjQ=' } },
    }] },
  });
  assert.equal(entries[0].responseBody, null);
});

test('a non-HAR document fails loudly', () => {
  assert.throws(() => harToEntries({ nope: true }), /not a HAR/);
});
