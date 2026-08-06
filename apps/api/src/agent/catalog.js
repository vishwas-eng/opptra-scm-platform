// API-side agent connector adapter. All metadata, tool specs, status assembly and tool
// execution live in @opptra/agent-connectors (shared with the worker). The one thing the
// API adds is HOW Unicommerce is reached: enqueue connector.unicommerce.invoke and poll
// the Run, because only the worker process may talk to UC.
import { config, query, createRun } from '@opptra/core';
import {
  LIVE_CONNECTOR_IDS, isLiveConnector, CONNECTOR_META,
  buildConnectorStatus, buildToolSpecs, isKnownTool,
  makeToolExecutor as makeSharedToolExecutor,
} from '@opptra/agent-connectors';
import { createUnicommerceConnector } from '@opptra/connectors-unicommerce';
import { createAmazonConnector } from '@opptra/connectors-amazon';
import { createFlipkartConnector } from '@opptra/connectors-flipkart';
import { createMyntraConnector } from '@opptra/connectors-myntra';
import { createNykaaConnector } from '@opptra/connectors-nykaa';
import { createZeptoConnector } from '@opptra/connectors-zepto';
import { createBlinkitConnector } from '@opptra/connectors-blinkit';
import { createInstamartConnector } from '@opptra/connectors-instamart';
import { createMeeshoConnector } from '@opptra/connectors-meesho';
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

export function makeToolExecutor({ userEmail, connectedIds }) {
  return makeSharedToolExecutor({
    userEmail,
    connectedIds,
    invokeUc: makeApiInvokeUc(userEmail),
  });
}

/** Capability catalog for docs/debug — includes disabled connectors' planned actions. */
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
  push('nykaa', createNykaaConnector({}).listCapabilities(), false);
  push('zepto', createZeptoConnector({}).listCapabilities(), false);
  push('blinkit', createBlinkitConnector({}).listCapabilities(), false);
  push('instamart', createInstamartConnector({}).listCapabilities(), false);
  push('meesho', createMeeshoConnector({}).listCapabilities(), false);
  push('6thstreet', createSixthStreetConnector({ cfg }).listCapabilities(), false);
  return caps;
}
