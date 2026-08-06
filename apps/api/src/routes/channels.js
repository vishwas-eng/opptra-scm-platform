// Channel operations, one uniform surface for every marketplace connector.
//
// Three things an operator can do with a channel, per region:
//   1. run an inventory sync now
//   2. run a sale-order punch now
//   3. schedule either of them at a time they choose
//
// Home Centre genuinely has two regions (UAE and KSA are separate UC tenants with
// different facilities and currencies), so every route is region-scoped rather than
// assuming one instance per channel.
import {
  audit,
  CHANNEL_OPERATIONS, regionsFor, listChannelSchedules, upsertChannelSchedule,
} from '@opptra/core';
import { enqueue } from '../queue.js';
import { createRun } from '@opptra/core';

// Which worker job runs each (channel, operation) pair.
const JOB_FOR = {
  homecentre: { inventory: 'homecentre.inventory', orders: 'homecentre.sync' },
  '6thstreet': { inventory: 'street6.inventory', orders: 'street6.packEmail' },
};

const CHANNELS = Object.keys(JOB_FOR);

function resolveTarget(connectorId, region, reply) {
  if (!CHANNELS.includes(connectorId)) {
    reply.code(404).send({ error: `unknown channel: ${connectorId}` });
    return null;
  }
  const allowed = regionsFor(connectorId);
  const chosen = region || allowed[0];
  if (!allowed.includes(chosen)) {
    reply.code(400).send({ error: `${connectorId} has no region "${chosen}" (expected ${allowed.join(' | ')})` });
    return null;
  }
  return chosen;
}

export default async function channelRoutes(app) {
  const opsOrAdmin = { preValidation: app.requireRole('admin', 'ops') };

  /** What can be run, where, and how it is currently scheduled. */
  app.get('/api/channels', opsOrAdmin, async () => {
    const schedules = await listChannelSchedules();
    const byKey = new Map(schedules.map((s) => [`${s.connector_id}|${s.region}|${s.operation}`, s]));
    return {
      ok: true,
      operations: CHANNEL_OPERATIONS,
      channels: CHANNELS.map((id) => ({
        id,
        regions: regionsFor(id).map((region) => ({
          region,
          operations: CHANNEL_OPERATIONS.map((operation) => ({
            operation,
            job: JOB_FOR[id][operation],
            schedule: byKey.get(`${id}|${region}|${operation}`) || null,
          })),
        })),
      })),
    };
  });

  /** Run one operation now. Dry-run unless the caller explicitly says otherwise. */
  app.post('/api/channels/:connectorId/:region/run/:operation', {
    ...opsOrAdmin,
    schema: {
      params: {
        type: 'object',
        required: ['connectorId', 'region', 'operation'],
        properties: {
          connectorId: { type: 'string' }, region: { type: 'string' }, operation: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          source: { type: 'string', enum: ['active', 'archive'] },
          skus: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          orderIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        },
      },
    },
  }, async (req, reply) => {
    const { connectorId, operation } = req.params;
    const region = resolveTarget(connectorId, req.params.region, reply);
    if (region === null) return undefined;
    if (!CHANNEL_OPERATIONS.includes(operation)) {
      return reply.code(400).send({ error: `unknown operation: ${operation}` });
    }

    // A write to a live marketplace must be asked for, never inferred from a default.
    const dryRun = req.body?.dryRun !== false;
    const run = await createRun({
      userEmail: req.user.email,
      automation: connectorId,
      action: `${operation}:${region}`,
      input: { region, operation, dryRun },
    });

    await enqueue(JOB_FOR[connectorId][operation], {
      runUid: run.run_uid,
      input: { ...(req.body || {}), dryRun, region, ucInstance: region },
    });
    await audit(req.user.email, 'channel-run', { connectorId, region, operation, dryRun });
    return { ok: true, runUid: run.run_uid, queued: true, region, operation, dryRun };
  });

  /** Create or update the schedule for one operation in one region. */
  app.put('/api/channels/:connectorId/:region/schedule/:operation', {
    ...opsOrAdmin,
    schema: {
      params: {
        type: 'object',
        required: ['connectorId', 'region', 'operation'],
        properties: {
          connectorId: { type: 'string' }, region: { type: 'string' }, operation: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          hour: { type: 'integer', minimum: 0, maximum: 23 },
          minute: { type: 'integer', enum: [0, 15, 30, 45] },
          timezone: { type: 'string', maxLength: 60 },
          dryRun: { type: 'boolean' },
          options: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    const { connectorId, operation } = req.params;
    const region = resolveTarget(connectorId, req.params.region, reply);
    if (region === null) return undefined;

    try {
      const schedule = await upsertChannelSchedule({
        connectorId,
        region,
        operation,
        enabled: req.body?.enabled ?? false,
        hour: req.body?.hour ?? 9,
        minute: req.body?.minute ?? 0,
        timezone: req.body?.timezone || (region === 'ksa' ? 'Asia/Riyadh' : 'Asia/Dubai'),
        dryRun: req.body?.dryRun !== false,
        options: req.body?.options || {},
        ownerEmail: req.user.email,
      });
      await audit(req.user.email, 'channel-schedule-set', {
        connectorId, region, operation, enabled: schedule.enabled,
        at: `${schedule.hour}:${String(schedule.minute).padStart(2, '0')} ${schedule.timezone}`,
      });
      // The worker re-reads schedules on its own tick; no restart needed.
      return { ok: true, schedule };
    } catch (err) {
      return reply.code(400).send({ error: String(err.message || err) });
    }
  });
}
