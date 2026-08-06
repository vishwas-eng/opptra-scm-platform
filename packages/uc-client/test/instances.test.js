import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInstanceId,
  resolveInstanceBaseUrl,
  instanceIdFromHost,
  UC_INSTANCE_IDS,
} from '../src/instances.js';

test('normalizeInstanceId accepts known ids', () => {
  assert.equal(normalizeInstanceId('INDIA'), 'india');
  assert.equal(normalizeInstanceId('staging'), 'staging');
  assert.equal(normalizeInstanceId('ksa'), 'ksa');
  assert.equal(normalizeInstanceId(undefined), 'india');
});

test('normalizeInstanceId rejects unknown', () => {
  assert.throws(() => normalizeInstanceId('prod'), /Unknown UC instance/);
});

test('resolveInstanceBaseUrl prefers config', () => {
  assert.match(resolveInstanceBaseUrl('india', { UC_BASE_URL: 'https://oppdoor.unicommerce.co.in/' }), /oppdoor\.unicommerce\.co\.in$/);
  assert.match(resolveInstanceBaseUrl('staging', { HC_UC_STAGING_BASE_URL: 'https://oppdoorstg.unicommerce.com' }), /oppdoorstg/);
  assert.match(resolveInstanceBaseUrl('uae', {}), /opptrauae/);
  assert.match(resolveInstanceBaseUrl('ksa', {}), /opptraksa/);
});

test('instanceIdFromHost maps hosts', () => {
  assert.equal(instanceIdFromHost('https://oppdoorstg.unicommerce.com'), 'staging');
  assert.equal(instanceIdFromHost('opptrauae.unicommerce.com'), 'uae');
  assert.equal(instanceIdFromHost('oppdooruae.unicommerce.com'), 'uae'); // legacy alias
  assert.equal(instanceIdFromHost('opptraksa.unicommerce.com'), 'ksa');
  assert.equal(instanceIdFromHost('https://oppdoor.unicommerce.co.in'), 'india');
  assert.equal(UC_INSTANCE_IDS.length, 4);
});
