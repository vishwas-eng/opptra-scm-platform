// Relay endpoints — the server side of packages/relay-agent.
//
// The agent runs on a machine that already sits inside a network we cannot reach (the
// 6th Street IBM OMS behind a Forti VPN whose gateway is a private address). It polls
// OUTBOUND over HTTPS, so there is no inbound firewall rule, no site-to-site tunnel,
// and MFA/split-tunnel are irrelevant — a human already authenticated that machine.
//
// Auth is the same personal access token the MCP bridge uses, so every relayed fetch is
// attributed to a real person and audited.
import { createHash } from 'node:crypto';
import {
  query, audit, logger,
  createRelayJob, claimRelayJob, completeRelayJob, getRelayJob, listRelayJobs,
} from '@opptra/core';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// One artifact is a picklist/invoice/label PDF. Generous, but not unbounded — an agent
// posting a 100 MB blob would blow the row and the request body limit alike.
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 12;

function providedToken(req) {
  const hdr = String(req.headers['x-opptra-token'] || '').trim();
  if (hdr) return hdr;
  const auth = String(req.headers.authorization || '').trim();
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
}

async function requireAgent(req, reply) {
  const raw = providedToken(req);
  if (!raw) return reply.code(401).send({ error: 'missing access token' });
  const { rows } = await query(
    'SELECT owner_email FROM ingest_tokens WHERE token_hash = $1 AND NOT revoked',
    [sha256(raw)],
  );
  if (!rows.length) return reply.code(401).send({ error: 'invalid or revoked access token' });
  const { rows: users } = await query(
    'SELECT email, role, is_active FROM users WHERE email = $1', [rows[0].owner_email],
  );
  if (!users.length || !users[0].is_active) {
    return reply.code(403).send({ error: 'token owner is not an active user' });
  }
  req.agentUser = users[0];
  return undefined;
}

export default async function relayRoutes(app) {
  const agentOnly = { preValidation: requireAgent };

  /** Agent poll: claim the next job, or 204 when there is nothing to do. */
  app.post('/api/relay/claim', {
    ...agentOnly,
    // Agents poll on an interval; this must not trip the global limiter.
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['connectorId', 'agentId'], additionalProperties: false,
        properties: {
          connectorId: { type: 'string', minLength: 1, maxLength: 40 },
          agentId: { type: 'string', minLength: 1, maxLength: 80 },
        },
      },
    },
  }, async (req, reply) => {
    const job = await claimRelayJob({
      connectorId: req.body.connectorId,
      agentId: `${req.agentUser.email}:${req.body.agentId}`,
    });
    if (!job) return reply.code(204).send();
    return { ok: true, job };
  });

  /** Agent posts the fetched documents (or the failure) back. */
  app.post('/api/relay/jobs/:jobUid/result', {
    ...agentOnly,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['jobUid'], properties: { jobUid: { type: 'string' } } },
      body: {
        type: 'object', required: ['agentId'], additionalProperties: false,
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 80 },
          error: { type: 'string', maxLength: 2000 },
          result: { type: 'object' },
          artifacts: {
            type: 'array',
            maxItems: MAX_ARTIFACTS,
            items: {
              type: 'object',
              required: ['name', 'base64'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', maxLength: 200 },
                contentType: { type: 'string', maxLength: 120 },
                base64: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const artifacts = req.body.artifacts || [];
    for (const a of artifacts) {
      // base64 inflates by ~4/3; check the decoded size, which is what actually matters.
      if ((a.base64.length * 3) / 4 > MAX_ARTIFACT_BYTES) {
        return reply.code(413).send({ error: `artifact ${a.name} exceeds ${MAX_ARTIFACT_BYTES} bytes` });
      }
    }

    const done = await completeRelayJob({
      jobUid: req.params.jobUid,
      agentId: `${req.agentUser.email}:${req.body.agentId}`,
      artifacts: artifacts.map((a) => ({
        name: a.name,
        contentType: a.contentType || 'application/octet-stream',
        size: Math.round((a.base64.length * 3) / 4),
        base64: a.base64,
      })),
      result: req.body.result || {},
      error: req.body.error || '',
    });

    if (!done) {
      // Either the claim expired and someone else took the job, or this agent never
      // held it. Either way its result is not authoritative.
      return reply.code(409).send({ error: 'job is not claimed by this agent (claim may have expired)' });
    }
    await audit(req.agentUser.email, 'relay-job-result', {
      jobUid: req.params.jobUid, status: done.status, artifacts: artifacts.length,
    });
    logger.info({ jobUid: req.params.jobUid, status: done.status }, 'relay job completed');
    return { ok: true, job: done };
  });

  /* ---- operator-facing (browser session) ---- */

  app.post('/api/relay/jobs', {
    preValidation: app.requireRole('admin', 'ops'),
    schema: {
      body: {
        type: 'object', required: ['connectorId', 'kind'], additionalProperties: false,
        properties: {
          connectorId: { type: 'string', maxLength: 40 },
          kind: { type: 'string', maxLength: 60 },
          payload: { type: 'object' },
        },
      },
    },
  }, async (req) => {
    const job = await createRelayJob({
      connectorId: req.body.connectorId,
      kind: req.body.kind,
      payload: req.body.payload || {},
      requestedBy: req.user.email,
    });
    await audit(req.user.email, 'relay-job-create', { jobUid: job.job_uid, kind: job.kind });
    return { ok: true, job };
  });

  app.get('/api/relay/jobs', {
    preValidation: app.requireRole('admin', 'ops'),
  }, async (req) => ({
    ok: true,
    jobs: await listRelayJobs({
      connectorId: req.query.connectorId || null,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 25,
    }),
  }));

  app.get('/api/relay/jobs/:jobUid', {
    preValidation: app.requireRole('admin', 'ops'),
  }, async (req, reply) => {
    const job = await getRelayJob(req.params.jobUid, { withArtifacts: req.query.artifacts === '1' });
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return { ok: true, job };
  });
}
