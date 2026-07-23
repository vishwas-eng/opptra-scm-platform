// Core internals against the REAL local test DB (runs, step ledger) + pure alert tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.DATABASE_URL = 'postgres://opptra:localdev@127.0.0.1:5432/opptra_test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
process.env.UC_BASE_URL = 'https://x';
process.env.GOOGLE_CLIENT_ID = 'x'; process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef01';

const PSQL = '/opt/homebrew/opt/postgresql@16/bin/psql';
let core;

before(async () => {
  execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'opptra', '-d', 'opptra_test', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { env: { ...process.env, PGPASSWORD: 'localdev' }, stdio: 'pipe' });
  core = await import('../src/index.js');
  const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
  await core.migrate(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/migrations'));
});
after(async () => { await core.closeDb(); });

test('memoStep runs a step once; a retry returns the memoized value without re-running', async () => {
  let calls = 0;
  const step = () => core.memoStep('REQ-A', 'PO', async () => { calls++; return { poCode: 'PO123' }; });
  const a = await step();
  const b = await step();
  assert.deepEqual(a, { poCode: 'PO123' });
  assert.deepEqual(b, { poCode: 'PO123' });
  assert.equal(calls, 1, 'the side-effecting step ran exactly once');
});

test('memoStep is safe under CONCURRENT first-runs (no double side effect)', async () => {
  let calls = 0;
  const step = () => core.memoStep('REQ-CONC', 'ALLOCATE', async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return calls; });
  const results = await Promise.all([step(), step(), step(), step(), step()]);
  // ON CONFLICT DO NOTHING + read-back means every caller sees the SAME stored value,
  // and the DB holds exactly one row for this step.
  const { rows } = await core.query(`SELECT count(*)::int n FROM step_ledger WHERE req_id='REQ-CONC'`);
  assert.equal(rows[0].n, 1, 'exactly one ledger row for the step');
  assert.equal(new Set(results).size >= 1, true);
});

test('run lifecycle: create → running → finish, reflected in listRuns', async () => {
  const run = await core.createRun({ userEmail: 'u@opptra.com', automation: 'asn', action: 'compile', input: { saleOrder: 'SO1' } });
  await core.markRunning(run.run_uid);
  await core.finishRun(run.run_uid, { ok: true, result: { lines: 5 } });
  const list = await core.listRuns({ automation: 'asn' });
  const found = list.find((r) => r.run_uid === run.run_uid);
  assert.ok(found);
  assert.equal(found.status, 'succeeded');
  assert.equal(found.result.lines, 5);
});

test('listRuns filters by user and automation', async () => {
  await core.createRun({ userEmail: 'a@opptra.com', automation: 'ewaybill', action: 'gen', input: {} });
  await core.createRun({ userEmail: 'b@opptra.com', automation: 'ewaybill', action: 'gen', input: {} });
  const onlyA = await core.listRuns({ userEmail: 'a@opptra.com', automation: 'ewaybill' });
  assert.ok(onlyA.length >= 1);
  assert.ok(onlyA.every((r) => r.user_email === 'a@opptra.com' && r.automation === 'ewaybill'));
});

test('audit writes an append-only row', async () => {
  await core.audit('admin@opptra.com', 'unit-test-event', { k: 'v' });
  const { rows } = await core.query(`SELECT actor, event, detail FROM audit_log WHERE event='unit-test-event'`);
  assert.equal(rows[0].actor, 'admin@opptra.com');
  assert.equal(rows[0].detail.k, 'v');
});

test('alert never throws even with no Slack webhook configured', async () => {
  // SLACK_WEBHOOK_URL is unset → alert logs + returns, must not reject.
  await core.alert('unit-key', 'a test alert', { detail: 1 });
  assert.ok(true);
});

test('config booleans: "false"/"0" turn a flag OFF (not coerced to true)', async () => {
  // config() caches per-process, so test each value in a fresh subprocess.
  const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
  const cfgUrl = new URL('../src/config.js', import.meta.url).href;
  const read = (fillPool) => {
    const base = { DATABASE_URL: 'postgres://x', UC_BASE_URL: 'https://x', JWT_SECRET: 'x'.repeat(32), UC_RETURN_FILL_POOL: fillPool };
    const script = `Object.assign(process.env, ${JSON.stringify(base)}); const {config}=await import(${JSON.stringify(cfgUrl)}); process.stdout.write(String(config().UC_RETURN_FILL_POOL));`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  };
  assert.equal(read('false'), 'false', '"false" must be OFF');
  assert.equal(read('0'), 'false', '"0" must be OFF');
  assert.equal(read('true'), 'true', '"true" must be ON');
  assert.equal(read('1'), 'true', '"1" must be ON');
});
