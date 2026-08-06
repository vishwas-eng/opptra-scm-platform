// Reconcile BullMQ repeatable jobs with the channel_schedules table.
//
// Cadence used to be an env var, so changing when a sync runs meant a redeploy and
// applied to every region at once. Operators now own the schedule in the UI; the worker
// polls the table and makes BullMQ match it.
//
// Reconciling (rather than only adding) is what makes disabling work: a schedule turned
// off in the UI must have its BullMQ job REMOVED, or it keeps firing forever.
import { listEnabledChannelSchedules, scheduleCron, scheduleKey, logger } from '@opptra/core';

const JOB_FOR = {
  homecentre: { inventory: 'homecentre.inventory', orders: 'homecentre.sync' },
  '6thstreet': { inventory: 'street6.inventory', orders: 'street6.packEmail' },
};

/** Schedulers this module owns — never touch anything else registered on the queue. */
const OWNED_PREFIX = 'channel:';

export async function reconcileChannelSchedules(queue) {
  const wanted = await listEnabledChannelSchedules();
  const wantedKeys = new Set();

  for (const row of wanted) {
    const jobName = JOB_FOR[row.connector_id]?.[row.operation];
    if (!jobName) {
      logger.warn({ row }, 'channel schedule references an unknown operation — skipped');
      continue;
    }
    const key = scheduleKey(row);
    wantedKeys.add(key);
    const { pattern, tz } = scheduleCron(row);

    await queue.upsertJobScheduler(key, { pattern, tz }, {
      name: jobName,
      data: {
        input: {
          // A scheduled run never silently writes to a live marketplace: dry_run is the
          // stored intent, and the operator has to choose otherwise explicitly.
          dryRun: row.dry_run !== false,
          region: row.region || undefined,
          ucInstance: row.region || undefined,
          ...(row.options || {}),
        },
        ownerEmail: row.owner_email || '',
        scheduleRef: {
          connectorId: row.connector_id, region: row.region || '', operation: row.operation,
        },
      },
      opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    });
  }

  // Remove schedulers we own that are no longer wanted (disabled or deleted).
  const existing = await queue.getJobSchedulers(0, 200).catch(() => []);
  let removed = 0;
  for (const s of existing) {
    const id = s?.key ?? s?.id ?? s?.name;
    if (typeof id !== 'string' || !id.startsWith(OWNED_PREFIX)) continue;
    if (wantedKeys.has(id)) continue;
    await queue.removeJobScheduler(id).catch(() => {});
    removed += 1;
  }

  logger.info({ active: wantedKeys.size, removed }, 'channel schedules reconciled');
  return { active: wantedKeys.size, removed };
}
