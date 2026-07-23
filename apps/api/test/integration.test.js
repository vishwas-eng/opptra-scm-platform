// End-to-end API integration against a REAL local Postgres + Redis.
// Covers every route with real DB writes: auth, RBAC, validation, run lifecycle,
// session paste, reverse-dc upload, admin surfaces, rate limiting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { setTestEnv, resetAndMigrate, agent } from './integration.helper.js';

setTestEnv();
let app; let core;

before(async () => {
  await resetAndMigrate();
  core = await import('@opptra/core');
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ withStatic: false });
});
after(async () => {
  await app?.close();
  const { closeQueues } = await import('../src/queue.js');
  await closeQueues();
  await core.closeDb();
});

/* ---------------------------- health & config ---------------------------- */
test('healthz reports db up once migrated', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  const b = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(b.db, true);
  assert.equal(b.ok, true);
});

/* ------------------------------- auth flow ------------------------------- */
test('anonymous is blocked on every protected route (401 before validation)', async () => {
  for (const url of ['/api/me', '/api/runs', '/api/dashboard', '/api/uc-session', '/api/admin/users', '/api/admin/analytics', '/api/admin/audit']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
  // POST with an INVALID body must still 401 (auth precedes schema validation).
  const r = await app.inject({ method: 'POST', url: '/api/automations/asn/compile', payload: { garbage: true } });
  assert.equal(r.statusCode, 401);
});

test('dev-login mints an admin session and /api/me returns the user', async () => {
  const a = agent(app);
  const login = await a.devLogin();
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.role, 'admin');
  const me = await a.get('/api/me');
  assert.equal(me.json().user.email, 'vishwas.pandey@opptra.com');
});

/* ----------------------------- validation -------------------------------- */
test('schema validation rejects bad input (400) after auth passes', async () => {
  const a = agent(app); await a.devLogin();
  assert.equal((await a.post('/api/automations/asn/compile', { saleOrder: 'SO1', channel: 'amazon' })).statusCode, 400); // bad enum
  assert.equal((await a.post('/api/automations/asn/compile', { saleOrder: 'bad space', channel: 'flipkart' })).statusCode, 400); // bad SO pattern
  assert.equal((await a.post('/api/automations/ewaybill/generate', { rows: [] })).statusCode, 400); // minItems
  assert.equal((await a.post('/api/automations/inward', { items: [] })).statusCode, 400);
});

/* --------------------------- run lifecycle ------------------------------- */
test('enqueue creates a run row; it is pollable and status-consistent', async () => {
  const a = agent(app); await a.devLogin();
  const res = await a.post('/api/automations/asn/compile', { saleOrder: 'SO02696', channel: 'myntra' });
  assert.equal(res.statusCode, 200);
  const { runUid, queued } = res.json();
  assert.ok(runUid && queued);
  const poll = await a.get('/api/runs/' + runUid);
  assert.equal(poll.statusCode, 200);
  const run = poll.json();
  assert.equal(run.run_uid, runUid);
  assert.equal(run.automation, 'asn');
  assert.ok(['queued', 'running', 'pending_retry', 'succeeded', 'failed'].includes(run.status));
  // shows up in the runs feed and dashboard counts
  const feed = await a.get('/api/runs?automation=asn');
  assert.ok(feed.json().runs.some((r) => r.run_uid === runUid));
  const dash = await a.get('/api/dashboard');
  assert.ok(dash.json().week.total >= 1);
});

test('unknown run id is 404', async () => {
  const a = agent(app); await a.devLogin();
  assert.equal((await a.get('/api/runs/00000000-0000-0000-0000-000000000000')).statusCode, 404);
});

/* ---------------------------- session paste ------------------------------ */
test('admin session paste persists, clears re-login, and surfaces via /api/uc-session', async () => {
  const a = agent(app); await a.devLogin();
  const paste = await a.post('/api/admin/uc-session', { jsessionid: 'INTEGRATION_COOKIE_123' });
  assert.equal(paste.statusCode, 200);
  const s = (await a.get('/api/uc-session')).json();
  assert.equal(s.has_cookie, true);
  assert.equal(s.source, 'admin-paste');
  assert.equal(s.needs_relogin, false);
  // the actual cookie value is never exposed
  assert.equal(s.jsessionid, undefined);
});

/* --------------------------- reverse dc upload --------------------------- */
test('reverse-dc: multipart PDF upload returns an edited Delivery Challan PDF', async () => {
  const a = agent(app); await a.devLogin();
  const doc = await PDFDocument.create(); doc.addPage([595, 842]);
  const pdf = Buffer.from(await doc.save());
  const boundary = '----itest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\nCustomer X\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="removeBarcode"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cn.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await a.raw({ method: 'POST', url: '/api/automations/reversedc/build', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 200);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.equal(out.file.contentType, 'application/pdf');
  assert.ok(Buffer.from(out.file.base64, 'base64').length > 500);
});

test('reverse-dc rejects a non-PDF upload with 400', async () => {
  const a = agent(app); await a.devLogin();
  const boundary = '----itest2';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nnot a pdf\r\n--${boundary}--\r\n`),
  ]);
  const res = await a.raw({ method: 'POST', url: '/api/automations/reversedc/build', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 400);
});

/* ------------------------------- RBAC ------------------------------------ */
test('RBAC: a viewer cannot run ops automations or hit admin routes', async () => {
  const admin = agent(app); await admin.devLogin();
  // create a viewer directly in the DB, then sign a viewer token via a second login path:
  await core.query(`INSERT INTO users (email, name, role) VALUES ('viewer@opptra.com','V','viewer')
    ON CONFLICT (email) DO UPDATE SET role='viewer'`);
  // demote isn't via dev-login (that's admin), so assert the guard from the role in a token:
  // sign a viewer JWT using the app's jwt so we exercise requireRole precisely.
  const token = app.jwt.sign({ email: 'viewer@opptra.com', name: 'V', role: 'viewer' });
  const asViewer = (url, method = 'GET', payload) => app.inject({ method, url, payload, headers: { cookie: `opptra_session=${token}` } });
  assert.equal((await asViewer('/api/automations/asn/compile', 'POST', { saleOrder: 'SO1', channel: 'flipkart' })).statusCode, 403);
  assert.equal((await asViewer('/api/admin/users')).statusCode, 403);
  // but a viewer can still read their own dashboard
  assert.equal((await asViewer('/api/dashboard')).statusCode, 200);
});

test('deactivated user is rejected immediately (DB re-check, not token TTL)', async () => {
  await core.query(`INSERT INTO users (email, name, role, is_active) VALUES ('gone@opptra.com','G','ops',false)
    ON CONFLICT (email) DO UPDATE SET is_active=false`);
  const token = app.jwt.sign({ email: 'gone@opptra.com', name: 'G', role: 'ops' });
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `opptra_session=${token}` } });
  // 403 (authenticated but not active) + cookie cleared — rejected immediately, not at TTL.
  assert.equal(res.statusCode, 403);
});

/* --------------------------- admin surfaces ------------------------------ */
test('admin analytics, users, audit, ingest tokens all return', async () => {
  const a = agent(app); await a.devLogin();
  const an = await a.get('/api/admin/analytics');
  assert.equal(an.statusCode, 200);
  assert.ok(an.json().byAutomation !== undefined && an.json().totals !== undefined);
  assert.equal((await a.get('/api/admin/users')).statusCode, 200);
  assert.equal((await a.get('/api/admin/audit')).statusCode, 200);
  const tok = await a.post('/api/admin/ingest-tokens', { label: 'itest' });
  assert.equal(tok.statusCode, 200);
  assert.ok(tok.json().token.length > 10); // shown once
  assert.ok((await a.get('/api/admin/ingest-tokens')).json().tokens.length >= 1);
});

/* --------------------------- rate limiting ------------------------------- */
test('per-user rate limit eventually returns 429 under a burst', async () => {
  const a = agent(app); await a.devLogin();
  let got429 = false;
  // ewaybill route is capped at 20/min per user; fire 30 fast.
  for (let i = 0; i < 30; i++) {
    const r = await a.post('/api/automations/ewaybill/generate', { rows: [{ so: 'SO' + i }], dryRun: true });
    if (r.statusCode === 429) { got429 = true; break; }
  }
  assert.ok(got429, 'expected a 429 after exceeding the per-user cap');
});
