import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReverseDcInput,
  validateEwaybillInput,
  validatePackingInput,
  validateSheetSaleOrders,
  validateAsnInput,
  validateRequiredId,
  validateIdList,
  asnUnsupportedChannelMessage,
  isValidGstin,
  isValidBulkReturnId,
  validationFailBody,
} from '../src/validate.js';

test('reverse DC accepts BR0160 / BR-0052 and rejects typos / multi-IDs', () => {
  const ok = validateReverseDcInput({ bulkReturnId: 'br0160', facility: 'Opp_WIQ_MH_1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.bulkReturnId, 'BR0160');

  const hyphen = validateReverseDcInput({ bulkReturnId: 'BR-0052', facility: 'Opp_WIQ_MH_1' });
  assert.equal(hyphen.ok, true);
  assert.equal(hyphen.bulkReturnId, 'BR-0052');

  for (const bad of ['vugj', 'BR0052 BR0053', 'BR0052,BR0053', 'hello', 'BR', '12345']) {
    const r = validateReverseDcInput({ bulkReturnId: bad, facility: 'Opp_WIQ_MH_1' });
    assert.equal(r.ok, false, `expected reject for ${bad}`);
    assert.match(r.error, /Bulk Return ID like BR0160/i);
    assert.ok(r.fieldErrors.some((f) => f.field === 'bulkReturnId'));
  }

  const noFac = validateReverseDcInput({ bulkReturnId: 'BR0160', facility: '  ' });
  assert.equal(noFac.ok, false);
  assert.match(noFac.error, /warehouse|facility/i);
});

test('isValidBulkReturnId / isValidGstin helpers', () => {
  assert.equal(isValidBulkReturnId('BR0160'), true);
  assert.equal(isValidBulkReturnId('vugj'), false);
  assert.equal(isValidGstin(''), true); // blank ok
  assert.equal(isValidGstin('27AAECO4444P1ZX'), true);
  assert.equal(isValidGstin('SHORT'), false);
  assert.equal(isValidGstin('27AAECO4444P1Z'), false); // 14 chars
});

test('e-way bill requires SO; GSTIN format; Road needs vehicle', () => {
  const empty = validateEwaybillInput({ rows: [] });
  assert.equal(empty.ok, false);

  const noSo = validateEwaybillInput({ rows: [{ so: '', transMode: 'ROAD', vehicleNo: 'MH12AB1234' }] });
  assert.equal(noSo.ok, false);
  assert.match(noSo.error, /SO Number is required/i);

  const badGstin = validateEwaybillInput({
    rows: [{ so: 'SO12345', gstin: 'BAD', transMode: 'ROAD', vehicleNo: 'MH12AB1234' }],
  });
  assert.equal(badGstin.ok, false);
  assert.match(badGstin.error, /GSTIN/i);
  assert.equal(badGstin.fieldErrors[0].row, 1);

  const roadNoVehicle = validateEwaybillInput({
    rows: [{ so: 'SO12345', transMode: 'ROAD' }],
  });
  assert.equal(roadNoVehicle.ok, false);
  assert.match(roadNoVehicle.error, /Vehicle number|4011/i);

  const ok = validateEwaybillInput({
    dryRun: true,
    rows: [
      { so: ' SO1 ', gstin: '27AAECO4444P1ZX', transMode: 'road', vehicleNo: ' MH12AB1234 ', distance: '' },
      { so: 'SO2', transMode: 'SHIP', vehicleNo: '' },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.rows[0].so, 'SO1');
  assert.equal(ok.rows[0].vehicleNo, 'MH12AB1234');
  assert.equal(ok.dryRun, true);

  // Bulk: report which row failed
  const multi = validateEwaybillInput({
    rows: [
      { so: 'SO1', transMode: 'ROAD', vehicleNo: 'MH01AA1111' },
      { so: 'SO2', gstin: 'notagstin', transMode: 'ROAD', vehicleNo: 'MH01AA2222' },
    ],
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.fieldErrors[0].row, 2);
  assert.match(multi.error, /row/i);
});

test('packing + sheet + order lookup ID lists', () => {
  assert.equal(validatePackingInput({ saleOrders: [] }).ok, false);
  assert.equal(validatePackingInput({ saleOrders: ['  SO1  ', 'SO2'] }).ok, true);
  assert.deepEqual(validatePackingInput({ saleOrders: ['  SO1  '] }).ids, ['SO1']);

  const badPack = validatePackingInput({ saleOrders: ['SO1', '???'] });
  assert.equal(badPack.ok, false);

  assert.equal(validateSheetSaleOrders([]).ok, true);
  assert.equal(validateSheetSaleOrders(['GP12345']).ok, true);
  assert.equal(validateSheetSaleOrders(['x']).ok, false); // too short

  const lookup = validateRequiredId('  SO999  ');
  assert.equal(lookup.ok, true);
  assert.equal(lookup.id, 'SO999');
  assert.equal(validateRequiredId('').ok, false);
  assert.equal(validateRequiredId('   ').ok, false);
});

test('ASN channel gate + unsupported message', () => {
  assert.equal(validateAsnInput({ saleOrder: 'SO1' }).ok, true);
  assert.equal(validateAsnInput({ saleOrder: 'SO1', channel: 'flipkart' }).ok, true);
  const amazon = validateAsnInput({ saleOrder: 'SO1', channel: 'amazon' });
  assert.equal(amazon.ok, false);
  assert.match(amazon.error, /Flipkart\/Myntra\/Zepto only/);

  assert.match(asnUnsupportedChannelMessage('Amazon_B2B'), /Flipkart\/Myntra\/Zepto only/);
  assert.match(asnUnsupportedChannelMessage('Amazon_B2B'), /Packing Mail/);
});

test('validateIdList respects max and required', () => {
  const tooMany = validateIdList(Array.from({ length: 3 }, (_, i) => `SO${i}`), { max: 2 });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /Maximum 2/);

  const optionalEmpty = validateIdList([], { required: false });
  assert.equal(optionalEmpty.ok, true);
  assert.deepEqual(optionalEmpty.ids, []);
});

test('validationFailBody shape for API 400', () => {
  const body = validationFailBody(failish());
  assert.equal(body.ok, false);
  assert.equal(body.error, 'boom');
  assert.equal(body.fieldErrors.length, 1);

  function failish() {
    return { ok: false, error: 'boom', fieldErrors: [{ field: 'x', message: 'boom' }] };
  }
});
