// Unicommerce connector HTTP surface. Capabilities/health metadata are sync;
// live UC calls only happen in the worker via connector.unicommerce.invoke.
import { createRun, query } from '@opptra/core';
import { createUnicommerceConnector, CONNECTOR_ID, CONNECTOR_NAME } from '@opptra/connectors-unicommerce';
import { enqueue } from '../queue.js';
import { perUser } from '../plugins/rateLimitKey.js';

/** Capability catalog without a live UcClient (handlers never run here). */
const catalog = createUnicommerceConnector({
  uc: {
    ping: async () => ({ alive: false }),
    listFacilities: async () => ({ all: [], current: null }),
    data: async () => ({}),
    dataGet: async () => ({}),
    public: async () => ({}),
  },
});

async function sessionVaultMeta() {
  try {
    const { rows } = await query(
      `SELECT instance_id, status, source, updated_at, last_ok_at, last_check_at, fail_count,
              needs_relogin, (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE instance_id = 'india'`,
    );
    const row = rows[0];
    if (!row) return { configured: false };
    return {
      configured: true,
      instanceId: row.instance_id || 'india',
      status: row.status,
      source: row.source,
      hasCookie: !!row.has_cookie,
      updatedAt: row.updated_at,
      lastOkAt: row.last_ok_at,
      lastCheckAt: row.last_check_at,
      failCount: row.fail_count,
      needsRelogin: !!row.needs_relogin,
      // Never include jsessionid.
    };
  } catch {
    return { configured: false, error: 'session vault unavailable' };
  }
}

export default async function connectorRoutes(app) {
  const opsOnly = app.requireRole('admin', 'ops');

  app.get('/api/connectors', { preValidation: app.requireUser }, async () => {
    const session = await sessionVaultMeta();
    return {
      connectors: [
        {
          id: CONNECTOR_ID,
          name: CONNECTOR_NAME,
          auth: catalog.auth,
          capabilities: catalog.listCapabilities().length,
          session,
        },
      ],
    };
  });

  app.get('/api/connectors/unicommerce/capabilities', { preValidation: opsOnly }, async () => ({
    connector: CONNECTOR_ID,
    capabilities: catalog.listCapabilities(),
  }));

  // Vault metadata only, live ping is POST invoke { action: 'health.ping' }.
  app.get('/api/connectors/unicommerce/health', { preValidation: opsOnly }, async () => {
    const session = await sessionVaultMeta();
    return {
      ok: session.configured && session.hasCookie && session.status === 'alive' && !session.needsRelogin,
      connector: CONNECTOR_ID,
      auth: catalog.auth,
      session,
      note: 'Live UC probe: POST /api/connectors/unicommerce/invoke with action health.ping',
    };
  });

  app.post('/api/connectors/unicommerce/invoke', {
    preValidation: opsOnly,
    config: perUser(60, '1 minute'),
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', minLength: 1, maxLength: 80 },
          params: { type: 'object' },
          dryRun: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    const action = String(req.body.action || '').trim();
    const known = catalog.listCapabilities().some((c) => c.id === action);
    if (!known) {
      const err = new Error(`unknown action: ${action}`);
      err.statusCode = 400;
      throw err;
    }
    const input = {
      action,
      params: req.body.params || {},
      dryRun: !!req.body.dryRun,
    };
    const run = await createRun({
      userEmail: req.user.email,
      automation: 'connector-unicommerce',
      action,
      input: { action, paramsKeys: Object.keys(input.params), dryRun: input.dryRun },
    });
    await enqueue('connector.unicommerce.invoke', { runUid: run.run_uid, input });
    return { runUid: run.run_uid, queued: true, connector: CONNECTOR_ID, action };
  });
}
