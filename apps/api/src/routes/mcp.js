// MCP bridge endpoints, the server side of packages/mcp-server (Claude Code / Cursor).
//
// The editor-side bridge is a thin stdio↔HTTPS shim; ALL brains stay here: connector
// registry, session vault, worker queue, rate limits, sanitizeResult, runs/audit. An MCP
// client therefore has exactly the same power and the same attribution as the same user
// in the web app's Agent chat, never more.
//
// Auth: personal access token from the Admin tab (ingest_tokens, hashed at rest,
// revocable, per-user). Bearer or X-Opptra-Token header.
import { createHash } from 'node:crypto';
import { query, audit } from '@opptra/core';
import { listConnectorStates } from '@opptra/core';
import { buildConnectorStatus, buildToolSpecs, isKnownTool, MUTATING_TOOLS } from '@opptra/agent-connectors';
import { makeToolExecutor } from '../agent/catalog.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function providedToken(req) {
  const hdr = String(req.headers['x-opptra-token'] || '').trim();
  if (hdr) return hdr;
  const auth = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

/** Resolve a personal access token to its owner, or reply 401. */
async function requireTokenUser(req, reply) {
  const raw = providedToken(req);
  if (!raw) return reply.code(401).send({ error: 'missing access token' });
  const { rows } = await query(
    'SELECT id, owner_email FROM ingest_tokens WHERE token_hash = $1 AND NOT revoked',
    [sha256(raw)],
  );
  if (!rows.length) return reply.code(401).send({ error: 'invalid or revoked access token' });
  const { rows: users } = await query(
    'SELECT email, role, is_active FROM users WHERE email = $1',
    [rows[0].owner_email],
  );
  if (!users.length || !users[0].is_active) {
    return reply.code(403).send({ error: 'token owner is not an active user' });
  }
  req.mcpUser = users[0];
  req.mcpTokenId = rows[0].id;
  await query('UPDATE ingest_tokens SET last_used = now() WHERE id = $1', [rows[0].id]);
}

async function connectedIdsFor(userEmail) {
  const prefs = await listConnectorStates(userEmail);
  const connectors = await buildConnectorStatus(prefs, { userEmail });
  return connectors.filter((c) => c.connected && c.live).map((c) => c.id);
}

export default async function mcpRoutes(app) {
  const tokenOnly = { preValidation: requireTokenUser };

  // Everything the calling user can do right now, in LLM tool-spec shape.
  app.get('/api/mcp/tools', {
    ...tokenOnly,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req) => {
    const connectedIds = await connectedIdsFor(req.mcpUser.email);
    const tools = buildToolSpecs(connectedIds).map((t) => ({
      ...t,
      mutates: MUTATING_TOOLS.has(t.name),
    }));
    return { ok: true, user: req.mcpUser.email, connectedIds, tools };
  });

  app.post('/api/mcp/call', {
    ...tokenOnly,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['tool'],
        additionalProperties: false,
        properties: {
          tool: { type: 'string', minLength: 1, maxLength: 128 },
          args: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    const { tool, args = {} } = req.body;
    if (!isKnownTool(tool)) {
      return reply.code(404).send({ ok: false, code: 'UNKNOWN_ACTION', error: `unknown tool: ${tool}` });
    }
    const userEmail = req.mcpUser.email;
    const connectedIds = await connectedIdsFor(userEmail);
    const executeTool = makeToolExecutor({ userEmail, connectedIds });
    const result = await executeTool(tool, args);
    await audit(userEmail, 'mcp-tool-call', {
      tool,
      argsKeys: Object.keys(args || {}),
      ok: result?.ok !== false,
      tokenId: req.mcpTokenId,
    });
    return { ok: result?.ok !== false, tool, result };
  });
}
