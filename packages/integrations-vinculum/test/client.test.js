import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  classifyImportResponse, extractPublicKeyPem, encryptPasswordRsaPkcs1, mapOrderRow,
} from '../src/client.js';

/* --------------------------- import classification --------------------------- */
// This is a LIVE stock write. A false "ok" means the team believes inventory was
// pushed when it was not — the most expensive failure this connector can produce.

test('an HTML error page returned with HTTP 200 is a failure, not a success', () => {
  const r = classifyImportResponse(200, '<html><body><div class="err">Error: invalid file format</div></body></html>');
  assert.equal(r.ok, false);
  assert.equal(r.confirmed, true);
  assert.match(r.reason, /import reported/i);
});

test('an explicit success page is confirmed', () => {
  const r = classifyImportResponse(200, '<html>Records processed: 151 uploaded successfully</html>');
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
});

test('a session bounce to the login page is a failure', () => {
  for (const body of ['Invalid Login Credentials', '<form action="sellerPanalLogin.action">']) {
    const r = classifyImportResponse(200, body);
    assert.equal(r.ok, false);
    assert.match(r.reason, /session expired|import reported/i);
  }
});

test('an ambiguous 200 is reported unconfirmed rather than assumed good', () => {
  const r = classifyImportResponse(200, '<html><body>&nbsp;</body></html>');
  assert.equal(r.ok, false);
  assert.equal(r.confirmed, false, 'we do not know either way — say so');
  assert.match(r.reason, /did not confirm/i);
});

test('a non-2xx status is a confirmed failure', () => {
  const r = classifyImportResponse(500, 'Internal Server Error');
  assert.equal(r.ok, false);
  assert.equal(r.confirmed, true);
  assert.match(r.reason, /HTTP 500/);
});

/* ------------------------------- RSA login ------------------------------- */

test('the RSA public key survives the page formatting Vinculum embeds it with', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const body = pem.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').trim();
  // The page indents each line inside a JS template literal and escapes newlines.
  const embedded = `var key = \`-----BEGIN PUBLIC KEY-----\\n\t\t${body.split('\n').join('\\n\t\t')}\\n-----END PUBLIC KEY-----\`;`;

  const extracted = extractPublicKeyPem(embedded);
  assert.match(extracted, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(extracted, /-----END PUBLIC KEY-----$/);
  // The real proof: the recovered key must actually encrypt.
  const enc = encryptPasswordRsaPkcs1('hunter2', extracted);
  assert.ok(enc.length > 40);
});

test('a login page with no key fails loudly — the layout changed', () => {
  assert.throws(() => extractPublicKeyPem('<html>no key here</html>'), /public key not found/i);
});

/* ------------------------------ order mapping ------------------------------ */

test('order rows map from Vinculum positional params', () => {
  const o = mapOrderRow({
    param1: '68243021288-1', param2: '2026-06-20', param5: 'Cushion Cover',
    param6: 'COD', param8: '2', param9: '899', param11: 'CONFIRMED',
    param12: 'LAND02600683', param13: 'OPPTRAHC', param21: 'HOMECENTREAE01',
  });
  assert.equal(o.webOrderNo, '68243021288-1');
  assert.equal(o.qty, 2);
  assert.equal(o.price, 899);
  assert.equal(o.cashOnDelivery, true, 'COD must be detected — it changes the UC payload');
  assert.equal(o.hcSku, 'LAND02600683');
  assert.equal(o.channel, 'HOMECENTREAE01');
});

test('uppercase PARAM keys are accepted too', () => {
  assert.equal(mapOrderRow({ PARAM1: 'X-1', PARAM8: '3' }).webOrderNo, 'X-1');
});

test('a row with no order number is mapped but identifiable as empty', () => {
  // syncOrders filters on webOrderNo, so this must come back falsy rather than throw.
  assert.equal(mapOrderRow({}).webOrderNo, '');
  assert.equal(mapOrderRow({}).qty, 1, 'quantity defaults to 1, never 0 or NaN');
});
