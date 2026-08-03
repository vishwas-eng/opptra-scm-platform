// Worker - THE only process that talks to Unicommerce. Concurrency 1: internal /data
// calls are facility-scoped session state, so serial execution is a correctness
// guarantee, not a performance compromise (uc-client's mutex is the second seatbelt).
process.env.SERVICE_NAME = 'worker';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config, logger, migrate, closeDb, markRunning, markPendingRetry, finishRun, alert, memoStep, getGoogleOAuthToken, getUserGoogleOAuthToken, savePackingThread, latestPackingThread, query } from '@opptra/core';
import { ucClient, SessionError, ConfigError } from '@opptra/uc-client';
import { createUnicommerceConnector } from '@opptra/connectors-unicommerce';
import { makeReturnPipeline } from '@opptra/automation-return';
import { makeEwaybillPipeline } from '@opptra/automation-ewaybill';
import { makeInventoryPipeline } from '@opptra/automation-inventory';
import { makeAsnPipeline } from '@opptra/automation-asn';
import { makeReverseDcPipeline } from '@opptra/automation-reversedc';
import { makePackingPipeline } from '@opptra/automation-packing';
import { makeSheetPipeline } from '@opptra/automation-sheet';
import { makeHomecentrePipeline } from '@opptra/automation-homecentre';
import { googleClients } from '@opptra/integrations-google';
import { makeHandlers } from './handlers.js';

const cfg = config();
const here = path.dirname(fileURLToPath(import.meta.url));

await migrate(path.join(here, '../../../packages/core/src/migrations'));

const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('automations', { connection });
const uc = ucClient();

// Build shared Google clients once at boot for Sheet Update + packing Sheets/Drive reads.
// Packing Mail Gmail uses each operator's own refresh token (resolved per job).
// Priority for shared:
//   1. stored OAuth refresh token (admin /auth/google/connect-shared)
//   2. GOOGLE_SA_KEY_JSON
//   3. GOOGLE_SA_EMAIL + GOOGLE_DELEGATED_USER
let google = null;
const oauthToken = await getGoogleOAuthToken().catch(() => null);
if (oauthToken?.refresh_token) {
  try {
    google = await googleClients({
      refreshToken: oauthToken.refresh_token, clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
      delegatedUser: oauthToken.granted_by,
    });
    logger.info({ user: oauthToken.granted_by, mode: 'oauth-refresh-token' }, 'shared google workspace connected');
  } catch (err) {
    logger.error({ err: String(err) }, 'shared google oauth token stored but auth FAILED - sheet stay disabled');
  }
} else if ((cfg.GOOGLE_SA_KEY_JSON || cfg.GOOGLE_SA_EMAIL) && cfg.GOOGLE_DELEGATED_USER) {
  try {
    google = await googleClients({ saKeyJson: cfg.GOOGLE_SA_KEY_JSON, saEmail: cfg.GOOGLE_SA_EMAIL, delegatedUser: cfg.GOOGLE_DELEGATED_USER });
    logger.info({ user: cfg.GOOGLE_DELEGATED_USER, mode: cfg.GOOGLE_SA_KEY_JSON ? 'key' : 'keyless' }, 'shared google workspace connected');
  } catch (err) {
    logger.error({ err: String(err) }, 'shared google workspace configured but auth FAILED - sheet stay disabled');
  }
}

/** Per-job Google client for packing: user's Gmail + shared Sheets/Drive when available. */
async function packingGoogleFor(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  const tok = email ? await getUserGoogleOAuthToken(email).catch(() => null) : null;
  let userClients = null;
  if (tok?.refresh_token) {
    try {
      userClients = await googleClients({
        refreshToken: tok.refresh_token,
        clientId: cfg.GOOGLE_CLIENT_ID,
        clientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
        delegatedUser: tok.granted_by || email,
      });
    } catch (err) {
      logger.error({ err: String(err), user: email }, 'user google oauth failed');
    }
  }
  if (!userClients && !google) return null;
  if (!userClients) {
    // Preview / sheet lookup can still work from shared; Gmail actions will refuse.
    return google;
  }
  return {
    gmail: userClients.gmail,
    drive: google?.drive || userClients.drive,
    sheets: google?.sheets || userClients.sheets,
    delegatedUser: tok.granted_by || email,
  };
}

async function runUserEmail(runUid, fallback = '') {
  if (!runUid) return String(fallback || '').trim().toLowerCase();
  const { rows } = await query('SELECT user_email FROM runs WHERE run_uid = $1', [runUid]).catch(() => ({ rows: [] }));
  return String(rows[0]?.user_email || fallback || '').trim().toLowerCase();
}

function packingPipelineFor(userEmail, googleForUser) {
  const email = String(userEmail || '').trim().toLowerCase();
  return makePackingPipeline(uc, cfg, googleForUser, {
    saveThread: (args) => savePackingThread({ ...args, userEmail: email }),
    latestThreadFor: (wh) => latestPackingThread(wh, email),
    fromName: email ? email.split('@')[0] : (cfg.MAIL_FROM_NAME || 'SupplyChain'),
  });
}

const unicommerceConnector = createUnicommerceConnector({ uc, logger });

const handlers = makeHandlers({
  uc,
  logger,
  alert,
  runs: { markRunning, markPendingRetry, finishRun },
  packingGoogleFor,
  runUserEmail,
  packingPipelineFor,
  unicommerceConnector,
  pipelines: {
    returnPipeline: makeReturnPipeline(uc, cfg),
    ewaybillPipeline: makeEwaybillPipeline(uc),
    inventoryPipeline: makeInventoryPipeline(uc, cfg, memoStep),
    asnPipeline: makeAsnPipeline(uc, cfg),
    reverseDcPipeline: makeReverseDcPipeline(uc),
    // Legacy shared pipeline kept for tests; packing handlers rebuild per user.
    packingPipeline: makePackingPipeline(uc, cfg, google, { saveThread: savePackingThread, latestThreadFor: latestPackingThread }),
    sheetPipeline: makeSheetPipeline(uc, cfg, google),
    homecentrePipeline: (cfg.VINCULUM_USER && cfg.VINCULUM_PASS)
      ? makeHomecentrePipeline(uc, cfg)
      : null,
  },
  reenqueue: (name, data, opts) => queue.add(name, data, opts),
});

/* ------------------------------ worker loop ------------------------------ */

const worker = new Worker('automations', async (job) => {
  const handler = handlers[job.name];
  if (!handler) {
    logger.error({ job: job.name }, 'no handler for job - dropping');
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

// Repeatable keep-alive (BullMQ job scheduler - replaces Apps Script time triggers).
await queue.upsertJobScheduler('keepalive', { every: cfg.UC_KEEPALIVE_MINUTES * 60_000 }, {
  name: 'system.keepalive', data: {}, opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 10 } },
});

// Scheduled source-sheet sync: pull orders from the read-only ops source into our Master
// so it stays current without anyone clicking anything. 0 minutes disables it.
if (cfg.SHEET_SYNC_MINUTES > 0) {
  await queue.upsertJobScheduler('sheet-sync-source', { every: cfg.SHEET_SYNC_MINUTES * 60_000 }, {
    name: 'sheet.syncSource', data: {}, opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 10 } },
  });
} else {
  await queue.removeJobScheduler('sheet-sync-source').catch(() => {});
}

// Home Centre is MANUAL ONLY for now (no orders yet / testing). Never auto-schedule.
await queue.removeJobScheduler('homecentre-sync').catch(() => {});

// Re-register active daily Agent playbooks after deploy/restart.
try {
  const { listActiveDailyPlaybooks } = await import('@opptra/core');
  const active = await listActiveDailyPlaybooks();
  for (const pb of active) {
    const hour = Math.min(23, Math.max(0, Number(pb.hour_utc) || 3));
    await queue.upsertJobScheduler(`agent-playbook-${pb.playbook_uid}`, { pattern: `0 ${hour} * * *` }, {
      name: 'agent.playbook.run',
      data: { playbookUid: pb.playbook_uid },
      opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    });
  }
  logger.info({ dailyPlaybooks: active.length }, 'agent playbook schedulers synced');
} catch (err) {
  logger.warn({ err: String(err.message || err) }, 'agent playbook scheduler sync skipped');
}

logger.info({ keepaliveEveryMin: cfg.UC_KEEPALIVE_MINUTES, hcManualOnly: true }, 'worker started');

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
