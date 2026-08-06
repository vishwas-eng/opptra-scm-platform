import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanError, humanSummary, RUN_STATUS_TEXT } from './humanError.js';

test('a dead Unicommerce session tells the operator who fixes it', () => {
  const h = humanError('GET /data/user/facilities: session expired (HTTP 401)');
  assert.match(h.title, /signed out/i);
  assert.match(h.fix, /reconnect Unicommerce/i);
  assert.ok(!/401|HTTP|\/data\//.test(h.title + h.detail + h.fix), 'no protocol detail in the plain text');
});

test('a portal block says it was deliberate, not that something broke', () => {
  const h = humanError({ code: 'PERMISSION_DENIED', error: 'nykaa returned a CAPTCHA signal', blocked: true });
  assert.match(h.title, /blocked us/i);
  assert.match(h.fix, /protect the account/i);
});

test('wrong credentials warn against retrying, because retrying locks the account', () => {
  const h = humanError('6th Street portal rejected the credentials: Incorrect username or password');
  assert.match(h.title, /wrong username or password/i);
  assert.match(h.fix, /do not keep retrying/i);
});

test('rate limiting reassures rather than alarms', () => {
  const h = humanError({ code: 'RATE_LIMITED', error: 'HTTP 429 too many requests' });
  assert.match(h.title, /slow down/i);
  assert.match(h.fix, /nothing to do/i);
});

test('the raw text is preserved for admins even though it is not shown', () => {
  const raw = 'UPSTREAM_ERROR 503 on /services/rest/v1/oms/saleOrder/create';
  assert.equal(humanError(raw).raw, raw);
});

test('an unrecognised failure still gets a usable message, never a blank', () => {
  const h = humanError('kfjghdfkjghdf');
  assert.ok(h.title && h.detail && h.fix);
  assert.match(h.fix, /send this to the team/i);
});

test('errors arrive in several shapes and all of them work', () => {
  for (const input of [
    'session expired',
    new Error('session expired'),
    { error: 'session expired' },
    { message: 'session expired' },
  ]) {
    assert.match(humanError(input).title, /signed out/i);
  }
});

test('run statuses read as plain English', () => {
  assert.equal(RUN_STATUS_TEXT.pending_retry, 'Trying again');
  assert.equal(RUN_STATUS_TEXT.failed, 'Did not finish');
});

test('a summary describes what happened without inventing anything', () => {
  assert.equal(humanSummary({ empty: true }), 'There was nothing new to process.');
  assert.match(humanSummary({ fetched: 12, okCount: 11, failed: 1 }), /12 found, 11 done, 1 failed/);
  assert.match(humanSummary({ skuCount: 151, dryRun: true }), /preview only, nothing was changed/);
  assert.equal(humanSummary(null), '', 'no data means no claim');
  assert.equal(humanSummary({}), '');
});
