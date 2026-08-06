import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbookCron, normalizeTimezone } from '../src/agentPlaybooks.js';

test('the ops ask "every day 9:00 IST" is now expressible', () => {
  // The whole point of the timezone column: IST is UTC+5:30, so 9:00 IST can never be
  // written as a whole-UTC-hour cron. BullMQ converts via tz.
  const cron = playbookCron({ hour_utc: 9, schedule_minute: 0, timezone: 'Asia/Kolkata' });
  assert.deepEqual(cron, { pattern: '0 9 * * *', tz: 'Asia/Kolkata' });
});

test('half-hour offsets survive: 9:30 in zone', () => {
  assert.deepEqual(
    playbookCron({ hour_utc: 9, schedule_minute: 30, timezone: 'Asia/Kolkata' }),
    { pattern: '30 9 * * *', tz: 'Asia/Kolkata' },
  );
});

test('legacy rows (no minute, no zone) keep their exact old firing time', () => {
  assert.deepEqual(playbookCron({ hour_utc: 3 }), { pattern: '0 3 * * *', tz: 'UTC' });
});

test('missing hour falls back to the historical 03:00 default', () => {
  assert.deepEqual(playbookCron({}), { pattern: '0 3 * * *', tz: 'UTC' });
  assert.deepEqual(playbookCron(null), { pattern: '0 3 * * *', tz: 'UTC' });
});

test('out-of-range hour/minute are clamped, never emitted as invalid cron', () => {
  assert.equal(playbookCron({ hour_utc: 99, schedule_minute: 99 }).pattern, '59 23 * * *');
  assert.equal(playbookCron({ hour_utc: -4, schedule_minute: -1 }).pattern, '0 0 * * *');
});

test('camelCase input (fresh API payload) works the same as DB snake_case', () => {
  assert.deepEqual(
    playbookCron({ hourUtc: 14, scheduleMinute: 15, timezone: 'Asia/Kolkata' }),
    { pattern: '15 14 * * *', tz: 'Asia/Kolkata' },
  );
});

test('an unresolvable zone degrades to UTC instead of silently firing at the wrong hour', () => {
  assert.equal(normalizeTimezone('Not/AZone'), 'UTC');
  assert.equal(normalizeTimezone(''), 'UTC');
  assert.equal(normalizeTimezone(null), 'UTC');
  assert.equal(playbookCron({ hour_utc: 9, timezone: 'Mars/Olympus' }).tz, 'UTC');
});

test('real IANA zones are preserved verbatim', () => {
  for (const tz of ['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London']) {
    assert.equal(normalizeTimezone(tz), tz);
  }
});
