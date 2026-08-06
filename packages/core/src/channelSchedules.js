// Channel operation schedules. One row per (connector, region, operation), edited by
// operators in the UI instead of by redeploying an env var.
import { query } from './db.js';

/** The operations every channel connector exposes, in the order the UI shows them. */
export const CHANNEL_OPERATIONS = Object.freeze(['inventory', 'orders']);

/**
 * Channels and their regions. A channel with real regional separation lists them; one
 * without uses a single '' region. Home Centre genuinely runs two independent
 * marketplaces (UAE and KSA) with different UC tenants, facilities and currencies, so
 * they are separate rows rather than one setting with a toggle.
 */
export const CHANNEL_REGIONS = Object.freeze({
  homecentre: ['uae', 'ksa'],
  '6thstreet': ['ksa'],
});

export function regionsFor(connectorId) {
  return CHANNEL_REGIONS[connectorId] || [''];
}

const VALID_MINUTES = new Set([0, 15, 30, 45]);

export function assertScheduleShape({ connectorId, region, operation, hour, minute }) {
  if (!CHANNEL_REGIONS[connectorId]) throw new Error(`unknown channel: ${connectorId}`);
  if (!regionsFor(connectorId).includes(region || '')) {
    throw new Error(`${connectorId} has no region "${region}" (expected ${regionsFor(connectorId).join(' | ')})`);
  }
  if (!CHANNEL_OPERATIONS.includes(operation)) {
    throw new Error(`unknown operation: ${operation} (expected ${CHANNEL_OPERATIONS.join(' | ')})`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be 0-23');
  if (!VALID_MINUTES.has(minute)) throw new Error('minute must be 0, 15, 30 or 45');
}

export async function listChannelSchedules({ connectorId } = {}) {
  const { rows } = await query(
    `SELECT connector_id, region, operation, enabled, hour, minute, timezone, dry_run,
            options, owner_email, last_run_at, last_status, last_error, updated_at
     FROM channel_schedules
     ${connectorId ? 'WHERE connector_id = $1' : ''}
     ORDER BY connector_id, region, operation`,
    connectorId ? [connectorId] : [],
  );
  return rows;
}

export async function upsertChannelSchedule({
  connectorId, region = '', operation, enabled = false,
  hour = 9, minute = 0, timezone = 'Asia/Dubai', dryRun = true, options = {}, ownerEmail = '',
}) {
  assertScheduleShape({ connectorId, region, operation, hour, minute });
  const { rows } = await query(
    `INSERT INTO channel_schedules
       (connector_id, region, operation, enabled, hour, minute, timezone, dry_run, options, owner_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT (connector_id, region, operation) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       hour = EXCLUDED.hour,
       minute = EXCLUDED.minute,
       timezone = EXCLUDED.timezone,
       dry_run = EXCLUDED.dry_run,
       options = EXCLUDED.options,
       owner_email = EXCLUDED.owner_email,
       updated_at = now()
     RETURNING connector_id, region, operation, enabled, hour, minute, timezone, dry_run, options, updated_at`,
    [connectorId, region, operation, enabled, hour, minute, timezone, dryRun, JSON.stringify(options || {}), ownerEmail],
  );
  return rows[0];
}

export async function markChannelScheduleRun({ connectorId, region = '', operation, status, error = '' }) {
  await query(
    `UPDATE channel_schedules
     SET last_run_at = now(), last_status = $4, last_error = $5, updated_at = now()
     WHERE connector_id = $1 AND region = $2 AND operation = $3`,
    [connectorId, region, operation, status, String(error || '').slice(0, 500)],
  );
}

export async function listEnabledChannelSchedules() {
  const { rows } = await query(
    `SELECT connector_id, region, operation, hour, minute, timezone, dry_run, options, owner_email
     FROM channel_schedules WHERE enabled = true`,
  );
  return rows;
}

/**
 * BullMQ repeatable-job spec for a schedule row.
 * Returns the cron in the row's own timezone — never converted to UTC, because a
 * half-hour-offset zone (IST) cannot be expressed as a whole UTC hour.
 */
export function scheduleCron(row) {
  return {
    pattern: `${Number(row.minute) || 0} ${Number(row.hour) || 0} * * *`,
    tz: row.timezone || 'Asia/Dubai',
  };
}

/** Stable BullMQ scheduler id, so re-saving a schedule replaces rather than duplicates. */
export function scheduleKey(row) {
  return `channel:${row.connector_id}:${row.region || 'default'}:${row.operation}`;
}
