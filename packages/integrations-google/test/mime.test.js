import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage, gmailApi, driveApi, sheetsApi, withGoogleRetry } from '../src/index.js';

const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('buildRawMessage produces valid MIME with headers and html body', () => {
  const raw = buildRawMessage({ to: 'wh@opptra.com', from: 'SupplyChain <sca@opptra.com>', subject: 'Packing SO123', htmlBody: '<p>Hi</p>' });
  const msg = decode(raw);
  assert.match(msg, /To: wh@opptra\.com/);
  assert.match(msg, /From: SupplyChain <sca@opptra\.com>/);
  assert.match(msg, /Subject: Packing SO123/);
  assert.match(msg, /Content-Type: text\/html/);
  assert.match(msg, /<p>Hi<\/p>/);
});

test('buildRawMessage attaches files as base64 parts', () => {
  const raw = buildRawMessage({
    to: ['a@opptra.com', 'b@opptra.com'], subject: 'x', htmlBody: 'y',
    attachments: [{ filename: 'inv.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 hello') }],
  });
  const msg = decode(raw);
  assert.match(msg, /To: a@opptra\.com, b@opptra\.com/);
  assert.match(msg, /Content-Disposition: attachment; filename="inv\.pdf"/);
  assert.match(msg, /multipart\/mixed; boundary=/);
});

test('buildRawMessage includes a Cc header when cc is provided', () => {
  const raw = buildRawMessage({
    to: ['a@opptra.com'], cc: ['ops@opptra.com', 'finance@opptra.com'],
    subject: 'x', htmlBody: 'y',
  });
  assert.match(decode(raw), /Cc: ops@opptra\.com, finance@opptra\.com/);
});

test('wrappers call the injected client with the right shape', async () => {
  const calls = [];
  const gmail = { users: { drafts: { create: async (a) => { calls.push(['draft', a]); return { data: { id: 'd1' } }; } } } };
  await gmailApi.createDraft(gmail, { to: 't@opptra.com', subject: 's', htmlBody: 'h' });
  assert.equal(calls[0][0], 'draft');
  assert.ok(calls[0][1].requestBody.message.raw.length > 10);

  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [['a', 'b']] } }) } } };
  const rows = await sheetsApi.read(sheets, 'sid', 'Tab!A1:B1');
  assert.deepEqual(rows, [['a', 'b']]);

  const drive = { files: { list: async () => ({ data: { files: [{ id: 'f1', name: 'label.pdf' }] } }) } };
  const files = await driveApi.listFolder(drive, 'folder1');
  assert.equal(files[0].name, 'label.pdf');
});

test('withGoogleRetry retries on 429 quota then succeeds', async () => {
  let n = 0;
  const r = await withGoogleRetry(async () => {
    n++;
    if (n < 3) { const e = new Error('rateLimitExceeded'); e.code = 429; throw e; }
    return 'ok';
  }, { tries: 5 });
  assert.equal(r, 'ok');
  assert.equal(n, 3);
});

test('withGoogleRetry does NOT retry a non-quota error (fails fast)', async () => {
  let n = 0;
  await assert.rejects(() => withGoogleRetry(async () => { n++; const e = new Error('bad range'); e.code = 400; throw e; }, { tries: 5 }));
  assert.equal(n, 1);
});

test('withGoogleRetry retries 403 userRateLimitExceeded but not plain 403', async () => {
  let n = 0;
  await assert.rejects(() => withGoogleRetry(async () => { n++; const e = new Error('forbidden'); e.code = 403; e.errors = [{ reason: 'insufficientPermissions' }]; throw e; }, { tries: 3 }));
  assert.equal(n, 1, 'permission 403 is not retried');
  let m = 0;
  await assert.rejects(() => withGoogleRetry(async () => { m++; const e = new Error('quota'); e.code = 403; e.errors = [{ reason: 'userRateLimitExceeded' }]; throw e; }, { tries: 3 }));
  assert.equal(m, 3, 'quota 403 IS retried');
});
