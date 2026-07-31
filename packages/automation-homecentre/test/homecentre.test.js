import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOrderRow, encryptPasswordRsaPkcs1, extractPublicKeyPem } from '@opptra/integrations-vinculum';
import { makeHomecentrePipeline } from '../src/pipeline.js';
import crypto from 'node:crypto';

test('mapOrderRow maps Vinculum param fields', () => {
  const o = mapOrderRow({
    param1: '68243021288-1',
    param6: 'COD',
    param8: '2',
    param9: '899',
    param12: 'LAND02600683',
    param21: 'HOMECENTREAE01',
  });
  assert.equal(o.webOrderNo, '68243021288-1');
  assert.equal(o.cashOnDelivery, true);
  assert.equal(o.qty, 2);
  assert.equal(o.price, 899);
  assert.equal(o.hcSku, 'LAND02600683');
  assert.equal(o.channel, 'HOMECENTREAE01');
});

test('RSA PKCS1 encrypt round-trips with generated key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const enc = encryptPasswordRsaPkcs1('secret', pem);
  const dec = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(enc, 'base64'),
  ).toString('utf8');
  assert.equal(dec, 'secret');
  assert.ok(extractPublicKeyPem(`var k = "${pem.replace(/\n/g, '\\n')}";`).includes('BEGIN PUBLIC KEY'));
});

test('punchOne dryRun maps SKU and builds SO code', async () => {
  const pipe = makeHomecentrePipeline({}, {
    HC_SKU_MAP_JSON: JSON.stringify({ LAND02600683: 'UC-SKU-1' }),
    HC_UC_CHANNEL: 'CUSTOM',
  }, {
    listActiveOrders: async () => ({ records: 1, orders: [] }),
    listArchiveOrders: async () => ({ records: 0, orders: [] }),
  });
  const r = await pipe.punchOne({
    webOrderNo: '68243021288-1',
    hcSku: 'LAND02600683',
    price: 899,
    qty: 1,
  }, { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.soCode, 'HC-68243021288-1');
  assert.equal(r.ucSku, 'UC-SKU-1');
});

test('syncOrders with zero orders is ok empty success', async () => {
  const pipe = makeHomecentrePipeline({}, { HC_UC_CHANNEL: 'CUSTOM' }, {
    listActiveOrders: async () => ({ records: 0, orders: [] }),
    listArchiveOrders: async () => ({ records: 0, orders: [] }),
  });
  const r = await pipe.syncOrders({ dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
  assert.equal(r.processed, 0);
  assert.match(r.message, /No Home Centre orders/);
});
