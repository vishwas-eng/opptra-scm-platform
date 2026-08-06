import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  classifyImportResponse, extractPublicKeyPem, encryptPasswordRsaPkcs1, mapOrderRow,
} from '../src/client.js';

/* --------------------------- import classification --------------------------- */
// Vinculum returns the SAME Update Price/Inventory page whether an import worked or
// not, so the response can never prove success. Only a transport failure, a dead
// session, or a quoted error sentence are real verdicts; everything else is accepted
// but unverified, and the pipeline confirms by re-reading the catalogue.

test('a quoted error sentence is a real failure', () => {
  const r = classifyImportResponse(200, '<html><body>Error: invalid file format</body></html>');
  assert.equal(r.ok, false);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /invalid file format/i);
});

test('the page tab labels never decide the verdict', () => {
  // The tabs read "Successful | Error | Pending" on every normal render. Treating the
  // word Error as a failure marked working uploads as failed for days.
  const page = '<html><body><li id="failedGridTab" onclick="genricSearchGrid(2)">Error</li>'
    + '<li id="successGridTab">Successful</li></body></html>';
  const r = classifyImportResponse(200, page);
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.verified, false, 'accepted is not the same as proven');
});

test('an accepted upload is never reported as verified', () => {
  const r = classifyImportResponse(200, '<html><body>Update Price/Inventory</body></html>');
  assert.equal(r.accepted, true);
  assert.equal(r.verified, false);
  assert.match(r.reason, /awaiting confirmation/i);
});

test('a batch number is captured when the page happens to carry one', () => {
  assert.equal(classifyImportResponse(200, '<html>batchId 884512</html>').batchNo, '884512');
});

test('a session bounce to login is a failure, not an accepted upload', () => {
  const r = classifyImportResponse(200, '<form action="sellerPanalLogin.action">');
  assert.equal(r.ok, false);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /session expired/i);
});

test('a non-2xx status is a failure', () => {
  const r = classifyImportResponse(500, 'Internal Server Error');
  assert.equal(r.ok, false);
  assert.equal(r.accepted, false);
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

test('a login page with no key fails loudly, the layout changed', () => {
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
  assert.equal(o.cashOnDelivery, true, 'COD must be detected, it changes the UC payload');
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

test('the Error tab in the page markup is not mistaken for a failed import', () => {
  // This is the exact response shape that wrongly failed a real upload: Vinculum
  // returns the whole Update Price/Inventory page, whose Error tab has id
  // "failedGridTab". Matching raw HTML saw the word "failed" and called it an error.
  const page = `<html><body>
    <ul class="nav">
      <li id="successGridTab" data-toggle="tab" onclick="genricSearchGrid(1);">Successful</li>
      <li id="failedGridTab" data-toggle="tab" onclick="genricSearchGrid(2);pageResized();">Error</li>
      <li id="pendingGridTab" data-toggle="tab">Pending</li>
    </ul>
    <div>Import Batch No 884512</div>
  </body></html>`;

  const r = classifyImportResponse(200, page);
  assert.equal(r.ok, true, 'tab markup must not be read as a failure');
  assert.equal(r.batchNo, '884512', 'the batch number is the real signal of acceptance');
});

test('a genuine error in the page TEXT is still caught', () => {
  const r = classifyImportResponse(200, '<html><body><div id="failedGridTab">Error</div><p>Invalid file format, import rejected</p></body></html>');
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid file format|rejected/i);
});

test('script and style contents never influence the verdict', () => {
  const r = classifyImportResponse(200,
    '<html><script>var failedRows=[];function showError(){}</script><body>Import Batch No 12345</body></html>');
  assert.equal(r.ok, true);
  assert.equal(r.batchNo, '12345');
});

