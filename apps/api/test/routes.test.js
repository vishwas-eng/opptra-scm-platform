import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Minimal env so config() validates. No real DB/Redis needed: every assertion below
// checks behavior that happens BEFORE any DB access (auth gating, validation, headers).
process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/none';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.UC_BASE_URL = 'https://oppdoorstg.unicommerce.com';
process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.PUBLIC_URL = 'https://scm.example.com';
process.env.OPS_AGENT_TOKEN = 'ops-test-token-0123456789abcdef01234567';

let app;
before(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ withStatic: false });
});
after(async () => { await app?.close(); });

test('protected routes reject anonymous callers with 401 (before any DB access)', async () => {
  const protectedGets = [
    '/api/me', '/api/runs', '/api/uc-session', '/api/admin/users', '/api/admin/analytics', '/api/admin/kpi',
    '/api/connectors', '/api/connectors/unicommerce/capabilities', '/api/connectors/unicommerce/health',
    '/api/automations/homecentre/status', '/api/automations/6thstreet/status',
    '/api/agent/meta', '/api/agent/connectors', '/api/agent/threads',
    '/api/admin/amazon/status', '/auth/amazon/connect', '/auth/amazon/callback',
  ];
  for (const url of protectedGets) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} should be 401 when unauthenticated`);
  }
  const post = await app.inject({ method: 'POST', url: '/api/automations/return/process', payload: { saleOrder: 'SO1' } });
  assert.equal(post.statusCode, 401, 'return/process must require auth');
  const invoke = await app.inject({
    method: 'POST', url: '/api/connectors/unicommerce/invoke',
    payload: { action: 'health.ping' },
  });
  assert.equal(invoke.statusCode, 401, 'connector invoke must require auth');
  const agentChat = await app.inject({
    method: 'POST', url: '/api/agent/chat',
    payload: { message: 'hello' },
  });
  assert.equal(agentChat.statusCode, 401, 'agent chat must require auth');
});

// Agent Beta is admin-only. Every route under /api/agent/* — including the ones added
// later for resources and playbooks — must refuse anonymous callers. A route shipped
// without a preValidation guard would answer 404/500 here instead of 401.
test('ADMIN-ONLY: every /api/agent/* route and connector mutation rejects anonymous', async () => {
  const cases = [
    ['GET', '/api/agent/meta'],
    ['GET', '/api/agent/connectors'],
    ['GET', '/api/agent/capabilities'],
    ['GET', '/api/agent/threads'],
    ['GET', '/api/agent/threads/abc/messages'],
    ['GET', '/api/agent/playbooks'],
    ['GET', '/api/agent/connectors/google-sheets/resources'],
    ['POST', '/api/agent/threads', {}],
    ['POST', '/api/agent/chat', { message: 'hi' }],
    ['POST', '/api/agent/playbooks', { title: 'x' }],
    ['POST', '/api/agent/playbooks/abc/activate', {}],
    ['POST', '/api/agent/playbooks/abc/pause', {}],
    ['POST', '/api/agent/playbooks/abc/run', {}],
    ['POST', '/api/agent/connectors/unicommerce/connect', {}],
    ['POST', '/api/agent/connectors/unicommerce/disconnect', {}],
    ['POST', '/api/agent/connectors/google-sheets/resources', { url: 'x' }],
    ['DELETE', '/api/agent/connectors/google-sheets/resources/abc'],
    ['POST', '/api/connectors/unicommerce/invoke', { action: 'health.ping' }],
  ];
  for (const [method, url, payload] of cases) {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 401, `${method} ${url} should be 401 when unauthenticated, got ${res.statusCode}`);
  }
});

test('/api/ops/summary rejects missing or wrong ops token (before DB)', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/ops/summary' });
  assert.equal(anon.statusCode, 401);
  const bad = await app.inject({
    method: 'GET', url: '/api/ops/summary',
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(bad.statusCode, 401);
  const badHdr = await app.inject({
    method: 'GET', url: '/api/ops/summary',
    headers: { 'x-ops-token': 'also-wrong' },
  });
  assert.equal(badHdr.statusCode, 401);
});

test('/api/capture/* refuses anonymous callers (no token, no session)', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/capture/sessions' });
  assert.equal(list.statusCode, 401);
  const start = await app.inject({
    method: 'POST', url: '/api/capture/sessions', payload: { connectorId: 'nykaa' },
  });
  assert.equal(start.statusCode, 401);
  // A presented token must be VERIFIED against the DB, so in this DB-less harness the
  // token path 500s rather than 401s (same as /api/ops/summary above). What matters is
  // that it never succeeds and never silently falls through to session auth.
  const bad = await app.inject({
    method: 'POST', url: '/api/capture/sessions',
    headers: { authorization: 'Bearer not-a-real-token' },
    payload: { connectorId: 'nykaa' },
  });
  assert.ok(bad.statusCode >= 400, 'an unknown access token must never be accepted');
});

test('/api/mcp/* rejects missing token with 401 (before any DB access)', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/mcp/tools' });
  assert.equal(list.statusCode, 401);
  const call = await app.inject({
    method: 'POST', url: '/api/mcp/call',
    payload: { tool: 'unicommerce_health_ping', args: {} },
  });
  assert.equal(call.statusCode, 401);
  // Body validation must also hold for authenticated-shaped requests: no `tool` → 400
  // (Fastify schema fires before preValidation-independent handler logic).
  const noTool = await app.inject({ method: 'POST', url: '/api/mcp/call', payload: { args: {} } });
  assert.ok([400, 401].includes(noTool.statusCode));
});

test('/api/ops/summary accepts Bearer or X-Ops-Token (auth gate only; DB may 500 in this harness)', async () => {
  // With a valid token, preValidation passes. This harness has no real DB, so the
  // handler may 500 — that still proves the machine-auth gate opened (not 401).
  for (const headers of [
    { authorization: 'Bearer ops-test-token-0123456789abcdef01234567' },
    { 'x-ops-token': 'ops-test-token-0123456789abcdef01234567' },
  ]) {
    const res = await app.inject({ method: 'GET', url: '/api/ops/summary', headers });
    assert.notEqual(res.statusCode, 401, `expected auth to pass with ${JSON.stringify(headers)}`);
    assert.notEqual(res.statusCode, 503);
  }
});

test('security headers present (helmet) and framing denied', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.ok(res.headers['content-security-policy'], 'CSP header set');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
});

test('/api/config exposes only the public Google client id', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.googleClientId, 'test.apps.googleusercontent.com');
  // Only public fields: the client id and the dev-login flag. No secrets.
  assert.deepEqual(Object.keys(body).sort(), ['devLogin', 'googleClientId']);
});

test('auth login rejects a missing/short credential via schema (400, no DB touched)', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { credential: 'x' } });
  assert.equal(res.statusCode, 400);
});

test('unknown api route returns 404 json (not the SPA)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(res.statusCode, 404);
});
