import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_OPERATIONS, CHANNEL_REGIONS, regionsFor, assertScheduleShape,
  scheduleCron, scheduleKey,
} from '../src/channelSchedules.js';

test('Home Centre is modelled as two independent marketplaces, not one with a toggle', () => {
  // UAE and KSA have different UC tenants, facilities and currencies, collapsing them
  // into one schedule would make it impossible to sync them at different times.
  assert.deepEqual(CHANNEL_REGIONS.homecentre, ['uae', 'ksa']);
  assert.deepEqual(regionsFor('homecentre'), ['uae', 'ksa']);
});

test('a channel with no regional split still has exactly one slot', () => {
  assert.deepEqual(regionsFor('nykaa'), ['']);
});

test('both operations exist for every channel', () => {
  assert.deepEqual(CHANNEL_OPERATIONS, ['inventory', 'orders']);
});

test('schedule validation rejects the mistakes that would silently misfire', () => {
  const base = { connectorId: 'homecentre', region: 'uae', operation: 'inventory', hour: 9, minute: 0 };
  assert.doesNotThrow(() => assertScheduleShape(base));

  assert.throws(() => assertScheduleShape({ ...base, connectorId: 'nope' }), /unknown channel/);
  assert.throws(() => assertScheduleShape({ ...base, region: 'india' }), /no region "india"/);
  assert.throws(() => assertScheduleShape({ ...base, operation: 'refunds' }), /unknown operation/);
  assert.throws(() => assertScheduleShape({ ...base, hour: 24 }), /hour must be 0-23/);
  assert.throws(() => assertScheduleShape({ ...base, hour: 9.5 }), /hour must be 0-23/);
  assert.throws(() => assertScheduleShape({ ...base, minute: 7 }), /minute must be/);
});

test('KSA and UAE are both valid regions for Home Centre', () => {
  for (const region of ['uae', 'ksa']) {
    assert.doesNotThrow(() => assertScheduleShape({
      connectorId: 'homecentre', region, operation: 'orders', hour: 6, minute: 30,
    }));
  }
});

test('cron keeps the operator’s own timezone rather than converting to UTC', () => {
  // Asia/Dubai is +4 and Asia/Kolkata is +5:30. Converting to a UTC hour would round
  // the half-hour zone to the wrong time; BullMQ does the conversion with tz.
  assert.deepEqual(
    scheduleCron({ hour: 9, minute: 30, timezone: 'Asia/Dubai' }),
    { pattern: '30 9 * * *', tz: 'Asia/Dubai' },
  );
  assert.deepEqual(
    scheduleCron({ hour: 6, minute: 0, timezone: 'Asia/Riyadh' }),
    { pattern: '0 6 * * *', tz: 'Asia/Riyadh' },
  );
  assert.deepEqual(scheduleCron({}), { pattern: '0 0 * * *', tz: 'Asia/Dubai' });
});

test('scheduler keys are stable and unique per channel+region+operation', () => {
  const uaeInv = scheduleKey({ connector_id: 'homecentre', region: 'uae', operation: 'inventory' });
  const ksaInv = scheduleKey({ connector_id: 'homecentre', region: 'ksa', operation: 'inventory' });
  const uaeOrd = scheduleKey({ connector_id: 'homecentre', region: 'uae', operation: 'orders' });

  assert.notEqual(uaeInv, ksaInv, 'UAE and KSA must not share a scheduler slot');
  assert.notEqual(uaeInv, uaeOrd, 'inventory and orders must not share a scheduler slot');
  // Stability matters: re-saving a schedule must REPLACE its job, not add a second one
  // that fires the same sync twice.
  assert.equal(uaeInv, scheduleKey({ connector_id: 'homecentre', region: 'uae', operation: 'inventory' }));
  assert.equal(
    scheduleKey({ connector_id: 'nykaa', region: '', operation: 'orders' }),
    'channel:nykaa:default:orders',
  );
});
