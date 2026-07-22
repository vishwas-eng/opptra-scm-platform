// Worker — THE only process that talks to Unicommerce. Concurrency 1: internal /data
// calls are facility-scoped session state, so serial execution is a correctness
// guarantee, not a performance compromise (uc-client's mutex is the second seatbelt).
process.env.SERVICE_NAME = 'worker';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config, logger, migrate, closeDb, markRunning, markPendingRetry, finishRun, alert, memoStep } from '@opptra/core';
import { ucClient, SessionError, ConfigError } from '@opptra/uc-client';
import { makeReturnPipeline } from '@opptra/automation-return';
import { makeEwaybillPipeline } from '@opptra/automation-ewaybill';
import { makeInventoryPipeline } from '@opptra/automation-inventory';
import { makeAsnPipeline } from '@opptra/automation-asn';
import { makeReverseDcPipeline } from '@opptra/automation-reversedc';
import { makeHandlers } from './handlers.js';

const cfg = config();
const here = path.dirname(fileURLToPath(import.meta.url));

await migrate(path.join(here, '../../../packages/core/src/migrations'));

const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('automations', { connection });
const uc = ucClient();

const handlers = makeHandlers({
  uc,
  logger,
  alert,
  runs: { markRunning, markPendingRetry, finishRun },
  pipelines: {
    returnPipeline: makeReturnPipeline(uc, cfg),
    ewaybillPipeline: makeEwaybillPipeline(uc),
    inventoryPipeline: makeInventoryPipeline(uc, cfg, memoStep),
    asnPipeline: makeAsnPipeline(uc, cfg),
    reverseDcPipeline: makeReverseDcPipeline(uc, cfg),
  },
  reenqueue: (name, data, opts) => queue.add(name, data, opts),
});

/* ------------------------------ worker loop ------------------------------ */

const worker = new Worker('automations', async (job) => {
  const handler = handlers[job.name];
  if (!handler) {
    logger.error({ job: job.name }, 'no handler for job — dropping');
    return { dropped: true };
  }
  try {
    return await handler(job);
  } catch (err) {
    // Session/config problems already alerted inside uc-client; still record the run.
    const runUid = job.data?.runUid;
    if (runUid) await finishRun(runUid, { ok: false, error: String(err.message || err) }).catch(() => {});
    if (!(err instanceof SessionError) && !(err instanceof ConfigError)) {
      await alert('job-crashed', `Job ${job.name} crashed`, { error: String(err.message || err) });
    }
    throw err;
  }
}, { connection, concurrency: 1 });

worker.on('failed', (job, err) => logger.error({ job: job?.name, err: String(err) }, 'job failed'));
worker.on('error', (err) => logger.error({ err: String(err) }, 'worker error'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'UNHANDLED REJECTION'));

// Repeatable keep-alive (BullMQ job scheduler — replaces Apps Script time triggers).
await queue.upsertJobScheduler('keepalive', { every: cfg.UC_KEEPALIVE_MINUTES * 60_000 }, {
  name: 'system.keepalive', data: {}, opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 10 } },
});

logger.info({ keepaliveEveryMin: cfg.UC_KEEPALIVE_MINUTES }, 'worker started');

/* ------------------------------ shutdown ------------------------------ */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down worker (finishing current job)');
    try {
      await worker.close();       // waits for the in-flight job
      await queue.close();
      await connection.quit();
      await closeDb();
    } finally {
      process.exit(0);
    }
  });
}
