// Worker — THE only process that talks to Unicommerce. Concurrency 1: internal /data
// calls are facility-scoped session state, so serial execution is a correctness
// guarantee, not a performance compromise (uc-client's mutex is the second seatbelt).
process.env.SERVICE_NAME = 'worker';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config, logger, migrate, closeDb, markRunning, markPendingRetry, finishRun, alert } from '@opptra/core';
import { ucClient, SessionError, ConfigError } from '@opptra/uc-client';
import { makeReturnPipeline } from '@opptra/automation-return';

const cfg = config();
const here = path.dirname(fileURLToPath(import.meta.url));

await migrate(path.join(here, '../../../packages/core/src/migrations'));

const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('automations', { connection });
const uc = ucClient();
const returnPipeline = makeReturnPipeline(uc, { facility: cfg.UC_DEFAULT_FACILITY });

const MAX_PENDING_RETRIES = 40;      // resumable pipeline: ~40 × 90s ≈ 1h of patience
const PENDING_RETRY_DELAY_MS = 90_000;

/* ------------------------------ job handlers ------------------------------ */

const handlers = {
  // Keep-alive: ping UC, record liveness. Session death triggers refresh/alert inside uc-client.
  'system.keepalive': async () => {
    const r = await uc.ping();
    logger.info({ alive: r.alive, facility: r.currentFacility || null }, 'uc keepalive');
    return r;
  },

  // Read-only SO status probe for the UI.
  'uc.soStatus': async (job) => {
    const { runUid, input } = job.data;
    await markRunning(runUid);
    const st = await returnPipeline.state(input.saleOrder);
    await finishRun(runUid, { ok: true, result: st });
    return st;
  },

  // The return + re-dispatch pipeline. Resumable: pending results re-enqueue themselves.
  'return.process': async (job) => {
    const { runUid, input, retryCount = 0 } = job.data;
    await markRunning(runUid);
    const out = await returnPipeline.processSO(input.saleOrder, {
      cancelSO: input.cancelSO || '',
      awbFromSO: input.awbFromSO || '',
      returnIn: !!input.returnIn,
      deliver: input.deliver !== false,
    });

    if (out.pending) {
      if (retryCount >= MAX_PENDING_RETRIES) {
        await finishRun(runUid, { ok: false, result: out, error: `still pending after ${retryCount} retries — needs a human look` });
        await alert('return-stuck', `Return pipeline stuck on ${input.saleOrder}`, { runUid, steps: JSON.stringify(out.steps) });
        return out;
      }
      await markPendingRetry(runUid, out);
      await queue.add('return.process',
        { runUid, input, retryCount: retryCount + 1 },
        { delay: PENDING_RETRY_DELAY_MS });
      logger.info({ so: input.saleOrder, retryCount }, 'return pipeline pending — re-enqueued');
      return out;
    }

    await finishRun(runUid, { ok: out.ok, result: out, error: out.error || null });
    if (!out.ok) await alert('return-failed', `Return pipeline FAILED on ${input.saleOrder}`, { runUid, error: out.error });
    return out;
  },
};

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
