import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage, gmailApi, driveApi, sheetsApi } from '../src/index.js';

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

test('unicode subject is RFC-2047 encoded', () => {
  const raw = buildRawMessage({ to: 'x@opptra.com', subject: 'Pédido ✓', htmlBody: 'y' });
  assert.match(decode(raw), /Subject: =\?UTF-8\?B\?/);
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
