// Connector capture — "connect once, we take it from there".
//
// The operator opens the seller portal from the Connectors page and logs in normally.
// The Opptra Capture extension records the session's network traffic and posts it here.
// This route then does the part that used to be a human reading a HAR for an afternoon:
//
//   1. extract the live session material and SEAL it into the connector vault,
//   2. redact every stored entry so the capture itself carries no working credential,
//   3. analyze the traffic into a connector blueprint (host, auth model, endpoints,
//      payload shapes, candidate actions).
//
// Auth: the same personal access tokens the MCP bridge uses (extension) or a logged-in
// admin session (HAR upload from the web app).
import { createHash } from 'node:crypto';
import {
  query, audit, logger, setConnectorCredential,
  createCaptureSession, appendCaptureEntries, finishCaptureSession,
  listCaptureSessions, getCaptureSession, deleteCaptureSession,
} from '@opptra/core';
import { CONNECTOR_META } from '@opptra/agent-connectors';
import { analyzeCapture, redactEntry, extractSessionMaterial, harToEntries } from '@opptra/capture';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KNOWN_CONNECTOR_IDS = new Set(CONNECTOR_META.map((c) => c.id));

function providedToken(req) {
  const hdr = String(req.headers['x-opptra-token'] || '').trim();
  if (hdr) return hdr;
  const auth = String(req.headers.authorization || '').trim();
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
}

/**
 * Accept EITHER a personal access token (the extension has no cookie) or a normal
 * logged-in session. Resolves req.captureUser either way.
 */
function makeCaptureAuth(app) {
  return async function captureAuth(req, reply) {
    const raw = providedToken(req);
    if (raw) {
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
      req.captureUser = users[0];
      return undefined;
    }
    // Fall back to the browser session (admin uploading a HAR from the web app).
    // currentUser sends its own 401/403 and returns null in that case.
    const row = await app.currentUser(req, reply);
    if (!row) return undefined;
    if (!['admin', 'ops'].includes(row.role)) {
      return reply.code(403).send({ error: 'requires role: admin or ops' });
    }
    req.captureUser = row;
    return undefined;
  };
}

function assertKnownConnector(connectorId, reply) {
  if (!KNOWN_CONNECTOR_IDS.has(connectorId)) {
    reply.code(400).send({ error: `unknown connector: ${connectorId}` });
    return false;
  }
  return true;
}

/**
 * Seal captured session material into the vault, keyed by connector.
 * @returns {boolean} whether anything usable was stored
 */
async function storeSessionMaterial({ connectorId, entries, updatedBy }) {
  const material = extractSessionMaterial(entries);
  const secret = material.cookieHeader || material.bearers[0] || '';
  if (!secret) return false;
  await setConnectorCredential({
    connectorId,
    ownerKey: 'shared',
    authKind: material.cookieHeader ? 'session' : 'bearer',
    secret,
    meta: {
      cookieNames: Object.keys(material.cookies),
      hasBearer: material.bearers.length > 0,
      capturedAt: new Date().toISOString(),
    },
    source: 'capture',
    updatedBy,
    status: 'configured',
  });
  return true;
}

export default async function captureRoutes(app) {
  const captureAuth = makeCaptureAuth(app);
  const authed = { preValidation: captureAuth };

  // Start a recording. The extension calls this, then streams entries to /entries.
  app.post('/api/capture/sessions', {
    ...authed,
    schema: {
      body: {
        type: 'object', required: ['connectorId'], additionalProperties: false,
        properties: {
          connectorId: { type: 'string', minLength: 1, maxLength: 40 },
          label: { type: 'string', maxLength: 120 },
        },
      },
    },
  }, async (req, reply) => {
    const { connectorId } = req.body;
    if (!assertKnownConnector(connectorId, reply)) return undefined;
    const session = await createCaptureSession({
      connectorId,
      label: req.body.label || '',
      ownerEmail: req.captureUser.email,
    });
    await audit(req.captureUser.email, 'capture-start', { connectorId, captureUid: session.capture_uid });
    return { ok: true, capture: session };
  });

  // Stream recorded requests. Redaction happens HERE, before anything is persisted.
  app.post('/api/capture/sessions/:captureUid/entries', {
    ...authed,
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['captureUid'], properties: { captureUid: { type: 'string' } } },
      body: {
        type: 'object', required: ['entries'], additionalProperties: false,
        properties: { entries: { type: 'array', maxItems: 500 } },
      },
    },
  }, async (req, reply) => {
    const raw = req.body.entries || [];
    // Session material must be lifted BEFORE redaction — after it, it is gone forever.
    const capture = await getCaptureSession(req.params.captureUid);
    if (!capture || capture.owner_email !== req.captureUser.email) {
      return reply.code(404).send({ error: 'capture not found' });
    }
    if (!capture.session_saved) {
      const saved = await storeSessionMaterial({
        connectorId: capture.connector_id,
        entries: raw,
        updatedBy: req.captureUser.email,
      });
      if (saved) {
        await query('UPDATE capture_sessions SET session_saved = true WHERE capture_uid = $1',
          [req.params.captureUid]);
      }
    }

    const result = await appendCaptureEntries({
      captureUid: req.params.captureUid,
      ownerEmail: req.captureUser.email,
      entries: raw.map(redactEntry),
    });
    if (!result) return reply.code(409).send({ error: 'capture is not recording' });
    return { ok: true, ...result };
  });

  // Stop recording and produce the blueprint.
  app.post('/api/capture/sessions/:captureUid/finish', {
    ...authed,
    schema: {
      params: { type: 'object', required: ['captureUid'], properties: { captureUid: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const capture = await getCaptureSession(req.params.captureUid, { withEntries: true });
    if (!capture || capture.owner_email !== req.captureUser.email) {
      return reply.code(404).send({ error: 'capture not found' });
    }
    let analysis;
    try {
      analysis = analyzeCapture(capture.entries || []);
    } catch (err) {
      logger.error({ err: String(err.message || err), captureUid: req.params.captureUid }, 'capture analysis failed');
      const failed = await finishCaptureSession({
        captureUid: req.params.captureUid, ownerEmail: req.captureUser.email,
        analysis: {}, error: String(err.message || err),
      });
      return reply.code(500).send({ ok: false, capture: failed, error: 'analysis failed' });
    }
    const done = await finishCaptureSession({
      captureUid: req.params.captureUid,
      ownerEmail: req.captureUser.email,
      analysis,
      sessionSaved: capture.session_saved,
    });
    await audit(req.captureUser.email, 'capture-finish', {
      connectorId: capture.connector_id,
      captureUid: req.params.captureUid,
      entries: capture.entry_count,
      endpoints: analysis.summary?.endpoints ?? 0,
      sessionSaved: capture.session_saved,
    });
    return { ok: true, capture: done };
  });

  // Upload a DevTools HAR instead of recording live — same pipeline, one shot.
  app.post('/api/capture/har', {
    ...authed,
    // A HAR is big; this route needs more than the 1 MB global body limit, so the
    // client posts it as multipart (handled by @fastify/multipart, 15 MB cap).
    schema: {
      querystring: {
        type: 'object', required: ['connectorId'],
        properties: {
          connectorId: { type: 'string', minLength: 1, maxLength: 40 },
          label: { type: 'string', maxLength: 120 },
        },
      },
    },
  }, async (req, reply) => {
    const { connectorId } = req.query;
    if (!assertKnownConnector(connectorId, reply)) return undefined;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'attach the .har file as multipart field "file"' });

    let entries;
    try {
      entries = harToEntries((await file.toBuffer()).toString('utf8'));
    } catch (err) {
      return reply.code(400).send({ error: `could not read HAR: ${String(err.message || err)}` });
    }

    const session = await createCaptureSession({
      connectorId, label: req.query.label || file.filename || 'HAR upload', ownerEmail: req.captureUser.email,
    });
    const sessionSaved = await storeSessionMaterial({
      connectorId, entries, updatedBy: req.captureUser.email,
    });
    await appendCaptureEntries({
      captureUid: session.capture_uid,
      ownerEmail: req.captureUser.email,
      entries: entries.map(redactEntry),
    });
    const done = await finishCaptureSession({
      captureUid: session.capture_uid,
      ownerEmail: req.captureUser.email,
      analysis: analyzeCapture(entries),
      sessionSaved,
    });
    await audit(req.captureUser.email, 'capture-har-upload', {
      connectorId, captureUid: session.capture_uid, entries: entries.length, sessionSaved,
    });
    return { ok: true, capture: done };
  });

  app.get('/api/capture/sessions', authed, async (req) => ({
    ok: true,
    captures: await listCaptureSessions({
      connectorId: req.query.connectorId || null,
      limit: Number(req.query.limit) || 25,
    }),
  }));

  app.get('/api/capture/sessions/:captureUid', authed, async (req, reply) => {
    const capture = await getCaptureSession(req.params.captureUid, {
      withEntries: req.query.entries === '1',
    });
    if (!capture) return reply.code(404).send({ error: 'capture not found' });
    return { ok: true, capture };
  });

  app.delete('/api/capture/sessions/:captureUid', {
    preValidation: app.requireRole('admin'),
  }, async (req) => {
    await deleteCaptureSession(req.params.captureUid);
    await audit(req.user.email, 'capture-delete', { captureUid: req.params.captureUid });
    return { ok: true };
  });
}
