import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_ERROR_CODES, connectorError, isRetryable } from '../src/index.js';

test('connectorError builds the standard shape', () => {
  const e = connectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED, 'no edit access', { permissionDenied: true });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'PERMISSION_DENIED');
  assert.equal(e.error, 'no edit access');
  assert.equal(e.retryable, false);
  assert.equal(e.permissionDenied, true);
});

test('transient codes are retryable by default; explicit override wins', () => {
  assert.equal(connectorError(CONNECTOR_ERROR_CODES.RATE_LIMITED, 'slow down').retryable, true);
  assert.equal(connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, '502').retryable, true);
  assert.equal(connectorError(CONNECTOR_ERROR_CODES.TIMEOUT, 'gave up').retryable, true);
  assert.equal(connectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED, 'dead session').retryable, false);
  assert.equal(connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, '502', { retryable: false }).retryable, false);
});

test('unknown codes collapse to INTERNAL rather than inventing taxonomy', () => {
  const e = connectorError('SOMETHING_NEW', 'oops');
  assert.equal(e.code, 'INTERNAL');
});

test('isRetryable only for failed results marked retryable', () => {
  assert.equal(isRetryable(connectorError(CONNECTOR_ERROR_CODES.RATE_LIMITED, 'x')), true);
  assert.equal(isRetryable(connectorError(CONNECTOR_ERROR_CODES.NOT_BOUND, 'x')), false);
  assert.equal(isRetryable({ ok: true }), false);
  assert.equal(isRetryable(null), false);
});
