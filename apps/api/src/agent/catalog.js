// API-side agent connector adapter. All metadata, tool specs, status assembly and tool
// execution live in @opptra/agent-connectors (shared with the worker). The one thing the
// API adds is HOW Unicommerce is reached: enqueue connector.unicommerce.invoke and poll
// the Run, because only the worker process may talk to UC.
import { config, query, createRun, upsertChannelSchedule } from '@opptra/core';
import {
  LIVE_CONNECTOR_IDS, isLiveConnector, CONNECTOR_META,
  buildConnectorStatus, buildToolSpecs, isKnownTool,
  makeToolExecutor as makeSharedToolExecutor,
} from '@opptra/agent-connectors';
import { createUnicommerceConnector } from '@opptra/connectors-unicommerce';
import { createAmazonConnector } from '@opptra/connectors-amazon';
import { createFlipkartConnector } from '@opptra/connectors-flipkart';
import { createMyntraConnector } from '@opptra/connectors-myntra';
import { createAllChannelStubs } from '@opptra/connectors-stubs';
import { createSixthStreetConnector } from '@opptra/connectors-6thstreet';
import { enqueue } from '../queue.js';

export {
  LIVE_CONNECTOR_IDS, isLiveConnector, CONNECTOR_META,
  buildConnectorStatus, buildToolSpecs, isKnownTool,
};

async function waitForRun(runUid, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { rows } = await query(`SELECT status, result, error FROM runs WHERE run_uid = $1`, [runUid]);
    const row = rows[0];
    if (!row) return { ok: false, error: 'run not found' };
    if (row.status === 'succeeded') return { ok: true, ...(row.result || {}) };
    if (row.status === 'failed') return { ok: false, error: row.error || 'run failed', result: row.result };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, error: 'timeout waiting for worker', retryable: true };
}

function makeApiInvokeUc(userEmail) {
  return async function invokeUc(action, params = {}) {
    const run = await createRun({
      userEmail,
      automation: 'connector-unicommerce',
      action,
      input: { action, paramsKeys: Object.keys(params || {}) },
    });
    await enqueue('connector.unicommerce.invoke', {
      runUid: run.run_uid,
      input: { action, params, dryRun: false },
    });
    return waitForRun(run.run_uid);
  };
}

/**
 * Let the agent start a channel job and schedule it, the bridge between "tell the
 * agent what you want" and the Channels screen. It goes through the same queue and the
 * same Run row as the button, so an agent-started sync is attributed and audited
 * identically to a human-started one.
 */
function makeChannelRunners(userEmail) {
  const JOB_FOR = {
    homecentre: { inventory: 'homecentre.inventory', orders: 'homecentre.sync' },
    '6thstreet': { inventory: 'street6.inventory', orders: 'street6.packEmail' },
  };

  return {
    async runChannelOperation({ connectorId, region, operation, dryRun = true, limit }) {
      const jobName = JOB_FOR[connectorId]?.[operation];
      if (!jobName) return { ok: false, error: `unknown operation ${connectorId}/${operation}` };

      const run = await createRun({
        userEmail,
        automation: connectorId,
        action: `${operation}:${region}`,
        input: { region, operation, dryRun, via: 'agent' },
      });
      await enqueue(jobName, {
        runUid: run.run_uid,
        input: { dryRun, region, ucInstance: region, ...(limit ? { limit } : {}) },
      });
      // Wait for the result so the agent can SHOW the operator what happened rather
      // than saying "queued" and leaving them to go looking.
      const result = await waitForRun(run.run_uid);
      return { ok: result.ok !== false, runUid: run.run_uid, region, operation, dryRun, result };
    },

    async scheduleChannelOperation({ connectorId, region, operation, enabled, hour, minute, dryRun }) {
      const schedule = await upsertChannelSchedule({
        connectorId,
        region,
        operation,
        enabled,
        hour,
        minute,
        timezone: region === 'ksa' ? 'Asia/Riyadh' : 'Asia/Dubai',
        dryRun,
        ownerEmail: userEmail,
      });
      return { ok: true, schedule };
    },
  };
}

export function makeToolExecutor({ userEmail, connectedIds }) {
  return makeSharedToolExecutor({
    userEmail,
    connectedIds,
    invokeUc: makeApiInvokeUc(userEmail),
    ...makeChannelRunners(userEmail),
  });
}

/** Capability catalog for docs/debug, includes disabled connectors' planned actions. */
export function listAllCapabilities() {
  const cfg = config();
  const caps = [];
  const push = (connectorId, list, live) => {
    for (const c of list) caps.push({ connectorId, live, ...c });
  };
  push('unicommerce', createUnicommerceConnector({
    uc: { ping: async () => ({ alive: false }), listFacilities: async () => ({ all: [], current: null }), data: async () => ({}), dataGet: async () => ({}), public: async () => ({}) },
  }).listCapabilities(), true);
  push('amazon', createAmazonConnector({ cfg }).listCapabilities(), false);
  push('flipkart', createFlipkartConnector({ cfg }).listCapabilities(), false);
  push('myntra', createMyntraConnector({}).listCapabilities(), false);
  for (const [id, stub] of createAllChannelStubs()) {
    push(id, stub.listCapabilities(), false);
  }
  push('6thstreet', createSixthStreetConnector({ cfg }).listCapabilities(), false);
  return caps;
}
