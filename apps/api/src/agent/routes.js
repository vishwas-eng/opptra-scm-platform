// Agent chat + connectors panel — ADMIN ONLY · Beta.
import {
  config, audit,
  createAgentThread, listAgentThreads, getAgentThread, touchAgentThread,
  addAgentMessage, listAgentMessages,
  listConnectorStates, setConnectorEnabled,
  setConnectorCredential, clearConnectorCredential,
  getGoogleOAuthToken,
} from '@opptra/core';
import { runAgentTurn, llmModeLabel } from '@opptra/agent-runtime';
import {
  LIVE_CONNECTOR_IDS, isLiveConnector, buildConnectorStatus,
  buildToolSpecs, makeToolExecutor, listAllCapabilities, CONNECTOR_META,
} from '../agent/catalog.js';

function userBucket(req) {
  try {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)opptra_session=([^;]+)/);
    if (m) {
      const payload = decodeURIComponent(m[1]).split('.')[1];
      const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (claims.email) return `u:${claims.email}`;
    }
  } catch { /* fall through */ }
  return `ip:${req.ip}`;
}
const perUser = (max, timeWindow) => ({ rateLimit: { max, timeWindow, keyGenerator: userBucket } });

function titleFromMessage(msg) {
  const t = String(msg || '').trim().replace(/\s+/g, ' ');
  return (t.slice(0, 48) || 'New chat') + (t.length > 48 ? '…' : '');
}

export default async function agentRoutes(app) {
  const adminOnly = app.requireRole('admin');

  app.get('/api/agent/meta', { preValidation: adminOnly }, async () => {
    const cfg = config();
    return {
      beta: true,
      label: 'Agent · Beta',
      llmMode: llmModeLabel(cfg),
      liveConnectors: LIVE_CONNECTOR_IDS,
      connectors: CONNECTOR_META.map((c) => ({
        id: c.id, name: c.name, live: !!c.live, group: c.group, icon: c.icon,
      })),
    };
  });

  // ── Connectors panel ──────────────────────────────────────────────
  app.get('/api/agent/connectors', { preValidation: adminOnly }, async (req) => {
    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs);
    return { beta: true, liveConnectors: LIVE_CONNECTOR_IDS, connectors };
  });

  app.get('/api/agent/capabilities', { preValidation: adminOnly }, async () => ({
    beta: true,
    capabilities: listAllCapabilities(),
  }));

  app.post('/api/agent/connectors/:id/connect', {
    preValidation: adminOnly,
    config: perUser(30, '1 minute'),
  }, async (req, reply) => {
    const id = String(req.params.id || '').trim();
    if (!isLiveConnector(id)) {
      return reply.code(403).send({
        error: 'This connector is coming soon and cannot be connected yet.',
        connector: id,
        status: 'coming_soon',
      });
    }

    const body = req.body || {};
    const cfg = config();

    // Optional session paste for marketplace-style vault (not used for disabled ones)
    if (body.session || body.secret) {
      const secret = String(body.session || body.secret || '').trim();
      if (secret.length < 8) return reply.code(400).send({ error: 'session/secret too short' });
      // Never allow pasting onto non-live (already blocked). UC uses Admin paste, not here —
      // except we allow enabling the agent pref when system is ready.
      if (['amazon', 'flipkart', 'myntra', 'nykaa', 'zepto', 'blinkit', 'instamart', 'meesho'].includes(id)) {
        return reply.code(403).send({ error: 'Marketplace connectors are coming soon.' });
      }
      await setConnectorCredential({
        connectorId: id,
        ownerKey: 'shared',
        authKind: body.authKind || 'session',
        secret,
        meta: { note: 'agent-connect' },
        source: 'agent-paste',
        updatedBy: req.user.email,
        status: 'configured',
      });
    }

    // System readiness gates
    if (id === 'unicommerce') {
      // Pref only — actual cookie stays in Admin UC session vault
    } else if (id === 'waypoint' && !cfg.WAYPOINT_DB_URL) {
      return reply.code(400).send({ error: 'WAYPOINT_DB_URL is not configured on the server.' });
    } else if ((id === 'google-sheets' || id === 'google-drive')) {
      const g = await getGoogleOAuthToken();
      const sa = !!(cfg.GOOGLE_SA_EMAIL && cfg.GOOGLE_DELEGATED_USER);
      if (!g.refresh_token && !sa) {
        return reply.code(400).send({
          error: 'Google Workspace not connected. Use Admin → Google shared connect first.',
          connectUrl: '/auth/google/connect-shared',
        });
      }
    } else if (id === 'homecentre' && !(cfg.VINCULUM_USER && cfg.VINCULUM_PASS)) {
      return reply.code(400).send({ error: 'VINCULUM_USER / VINCULUM_PASS not configured on the server.' });
    }

    const state = await setConnectorEnabled({
      userEmail: req.user.email,
      connectorId: id,
      enabled: true,
    });
    await audit(req.user.email, 'agent-connector-connect', { connector: id });
    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs);
    return { ok: true, state, connector: connectors.find((c) => c.id === id) };
  });

  app.post('/api/agent/connectors/:id/disconnect', {
    preValidation: adminOnly,
    config: perUser(30, '1 minute'),
  }, async (req, reply) => {
    const id = String(req.params.id || '').trim();
    if (!isLiveConnector(id)) {
      return reply.code(403).send({ error: 'This connector is coming soon.', connector: id });
    }
    const state = await setConnectorEnabled({
      userEmail: req.user.email,
      connectorId: id,
      enabled: false,
    });
    // Clear optional vault secret for non-shared Google/UC (UC session is NOT cleared here)
    if (id !== 'unicommerce' && id !== 'google-sheets' && id !== 'google-drive' && id !== 'waypoint' && id !== 'homecentre') {
      await clearConnectorCredential(id, 'shared').catch(() => {});
    }
    await audit(req.user.email, 'agent-connector-disconnect', { connector: id });
    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs);
    return { ok: true, state, connector: connectors.find((c) => c.id === id) };
  });

  // ── Threads ───────────────────────────────────────────────────────
  app.get('/api/agent/threads', { preValidation: adminOnly }, async (req) => {
    const threads = await listAgentThreads({ userEmail: req.user.email });
    return { threads };
  });

  app.post('/api/agent/threads', {
    preValidation: adminOnly,
    config: perUser(60, '1 minute'),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', maxLength: 120 } },
      },
    },
  }, async (req) => {
    const thread = await createAgentThread({
      userEmail: req.user.email,
      title: req.body?.title || 'New chat',
    });
    return { thread };
  });

  app.get('/api/agent/threads/:uid/messages', { preValidation: adminOnly }, async (req, reply) => {
    const thread = await getAgentThread({ threadUid: req.params.uid, userEmail: req.user.email });
    if (!thread) return reply.code(404).send({ error: 'thread not found' });
    const messages = await listAgentMessages({ threadId: thread.id });
    return { thread: { thread_uid: thread.thread_uid, title: thread.title }, messages };
  });

  // ── Chat ──────────────────────────────────────────────────────────
  app.post('/api/agent/chat', {
    preValidation: adminOnly,
    config: perUser(40, '1 minute'),
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        additionalProperties: false,
        properties: {
          threadId: { type: 'string', maxLength: 80 },
          message: { type: 'string', minLength: 1, maxLength: 8000 },
        },
      },
    },
  }, async (req, reply) => {
    const cfg = config();
    const message = String(req.body.message || '').trim();
    if (!message) return reply.code(400).send({ error: 'message required' });

    let thread;
    if (req.body.threadId) {
      thread = await getAgentThread({ threadUid: req.body.threadId, userEmail: req.user.email });
      if (!thread) return reply.code(404).send({ error: 'thread not found' });
    } else {
      thread = await createAgentThread({
        userEmail: req.user.email,
        title: titleFromMessage(message),
      });
    }

    await addAgentMessage({ threadId: thread.id, role: 'user', content: message });
    if (thread.title === 'New chat') {
      await touchAgentThread(thread.id, titleFromMessage(message));
    }

    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs);
    const connectedIds = connectors.filter((c) => c.connected && c.live).map((c) => c.id);

    const historyRows = await listAgentMessages({ threadId: thread.id, limit: 30 });
    const history = historyRows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // exclude the user msg we just added (passed as `message`)
      .map((m) => ({ role: m.role, content: m.content }));

    const tools = buildToolSpecs(connectedIds);
    const executeTool = makeToolExecutor({ userEmail: req.user.email, connectedIds });

    let result;
    try {
      result = await runAgentTurn({
        cfg,
        message,
        history,
        tools,
        executeTool,
        connectedIds,
      });
    } catch (err) {
      result = {
        mode: llmModeLabel(cfg),
        content: `Agent error: ${String(err.message || err)}`,
        toolCalls: [],
      };
    }

    const assistant = await addAgentMessage({
      threadId: thread.id,
      role: 'assistant',
      content: result.content || '',
      toolCalls: result.toolCalls || [],
      meta: { mode: result.mode, beta: true },
    });

    return {
      beta: true,
      threadId: thread.thread_uid,
      mode: result.mode,
      message: assistant,
      connectedIds,
    };
  });
}
