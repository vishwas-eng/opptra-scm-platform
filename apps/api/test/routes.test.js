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

let app;
before(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ withStatic: false });
});
after(async () => { await app?.close(); });

test('protected routes reject anonymous callers with 401 (before any DB access)', async () => {
  const protectedGets = ['/api/me', '/api/runs', '/api/uc-session', '/api/admin/users', '/api/admin/analytics'];
  for (const url of protectedGets) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} should be 401 when unauthenticated`);
  }
  const post = await app.inject({ method: 'POST', url: '/api/automations/return/process', payload: { saleOrder: 'SO1' } });
  assert.equal(post.statusCode, 401, 'return/process must require auth');
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
  assert.deepEqual(Object.keys(body), ['googleClientId']); // nothing else leaks
});

test('auth login rejects a missing/short credential via schema (400, no DB touched)', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { credential: 'x' } });
  assert.equal(res.statusCode, 400);
});

test('unknown api route returns 404 json (not the SPA)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(res.statusCode, 404);
});
