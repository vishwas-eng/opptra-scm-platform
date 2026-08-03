// Agent chat + connectors panel — ADMIN ONLY · Beta.
import {
  config, audit,
  createAgentThread, listAgentThreads, getAgentThread, touchAgentThread,
  addAgentMessage, listAgentMessages,
  listConnectorStates, setConnectorEnabled,
  setConnectorCredential, clearConnectorCredential,
  getUserGoogleOAuthToken, clearUserGoogleOAuthToken, userGoogleScopeStatus,
  createAgentPlaybook, listAgentPlaybooks, getAgentPlaybook, updateAgentPlaybook,
} from '@opptra/core';
import { runAgentTurn, llmModeLabel } from '@opptra/agent-runtime';
import {
  LIVE_CONNECTOR_IDS, isLiveConnector, buildConnectorStatus,
  buildToolSpecs, makeToolExecutor, listAllCapabilities, CONNECTOR_META,
} from '../agent/catalog.js';
import { enqueue, upsertScheduler, removeScheduler } from '../queue.js';

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

async function syncPlaybookScheduler(pb) {
  const schedulerId = `agent-playbook-${pb.playbook_uid}`;
  if (pb.status === 'active' && pb.schedule_kind === 'daily') {
    const hour = Math.min(23, Math.max(0, Number(pb.hour_utc) || 3));
    await upsertScheduler(
      schedulerId,
      { pattern: `0 ${hour} * * *` },
      {
        name: 'agent.playbook.run',
        data: { playbookUid: pb.playbook_uid },
        opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
      },
    );
  } else {
    await removeScheduler(schedulerId);
  }
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
    const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
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
      const tok = await getUserGoogleOAuthToken(req.user.email);
      const scopes = userGoogleScopeStatus(tok.scope);
      if (!tok.refresh_token || !scopes.ok) {
        return reply.code(400).send({
          error: !tok.refresh_token
            ? 'Connect your personal Google account first.'
            : `Missing Google scopes: ${scopes.missing.join(', ')}. Reconnect.`,
          oauthUrl: '/auth/google/connect?return=connectors',
          needsOAuth: true,
        });
      }
      // One Google OAuth powers both Sheets + Drive — enable both prefs.
      await setConnectorEnabled({ userEmail: req.user.email, connectorId: 'google-sheets', enabled: true });
      await setConnectorEnabled({ userEmail: req.user.email, connectorId: 'google-drive', enabled: true });
      await audit(req.user.email, 'agent-connector-connect', { connector: id, googleEmail: tok.google_email || tok.granted_by });
      const prefs = await listConnectorStates(req.user.email);
      const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
      return { ok: true, connector: connectors.find((c) => c.id === id), connectors };
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
    const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
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
    if (id === 'google-sheets' || id === 'google-drive') {
      // Disconnect Google for Agent: clear per-user OAuth (also affects Packing Mail Gmail).
      const clearToken = req.body?.revokeGoogle !== false;
      await setConnectorEnabled({ userEmail: req.user.email, connectorId: 'google-sheets', enabled: false });
      await setConnectorEnabled({ userEmail: req.user.email, connectorId: 'google-drive', enabled: false });
      if (clearToken) await clearUserGoogleOAuthToken(req.user.email);
      await audit(req.user.email, 'agent-connector-disconnect', { connector: id, revokedToken: clearToken });
      const prefs = await listConnectorStates(req.user.email);
      const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
      return { ok: true, connector: connectors.find((c) => c.id === id), connectors };
    }
    const state = await setConnectorEnabled({
      userEmail: req.user.email,
      connectorId: id,
      enabled: false,
    });
    if (id !== 'unicommerce' && id !== 'waypoint' && id !== 'homecentre') {
      await clearConnectorCredential(id, 'shared').catch(() => {});
    }
    await audit(req.user.email, 'agent-connector-disconnect', { connector: id });
    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
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
    const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
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
      canSaveAutomation: !!(result.toolCalls?.length),
    };
  });

  // ── Daily automations / playbooks ─────────────────────────────────
  app.get('/api/agent/playbooks', { preValidation: adminOnly }, async (req) => {
    const playbooks = await listAgentPlaybooks({ userEmail: req.user.email });
    return { beta: true, playbooks };
  });

  app.post('/api/agent/playbooks', {
    preValidation: adminOnly,
    config: perUser(20, '1 minute'),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 160 },
          instruction: { type: 'string', maxLength: 4000 },
          threadId: { type: 'string', maxLength: 80 },
          scheduleKind: { type: 'string', enum: ['manual', 'daily'] },
          hourUtc: { type: 'integer', minimum: 0, maximum: 23 },
          activate: { type: 'boolean' },
          steps: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              required: ['tool'],
              properties: {
                tool: { type: 'string', maxLength: 80 },
                args: { type: 'object' },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body || {};
    let steps = Array.isArray(body.steps) ? body.steps : [];

    // Prefer steps from the latest assistant tool calls on the thread.
    if ((!steps.length) && body.threadId) {
      const thread = await getAgentThread({ threadUid: body.threadId, userEmail: req.user.email });
      if (thread) {
        const msgs = await listAgentMessages({ threadId: thread.id, limit: 50 });
        const last = [...msgs].reverse().find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
        if (last) {
          steps = last.tool_calls
            .filter((t) => t && t.name && t.status !== 'error')
            .map((t) => ({ tool: t.name, args: t.args || {} }));
        }
      }
    }

    if (!steps.length && !String(body.instruction || '').trim()) {
      return reply.code(400).send({
        error: 'Provide steps or run a chat that uses tools first, then Save as daily automation.',
      });
    }

    const prefs = await listConnectorStates(req.user.email);
    const connectors = await buildConnectorStatus(prefs, { userEmail: req.user.email });
    const connectedIds = connectors.filter((c) => c.connected && c.live).map((c) => c.id);

    const scheduleKind = body.scheduleKind === 'daily' ? 'daily' : 'manual';
    const status = body.activate === false ? 'draft' : (scheduleKind === 'daily' ? 'active' : 'draft');
    const instruction = String(body.instruction || '').trim()
      || 'Replay saved Agent tool steps (from chat).';
    const title = String(body.title || '').trim()
      || (scheduleKind === 'daily' ? 'Daily automation' : 'Saved automation').slice(0, 160);

    const pb = await createAgentPlaybook({
      userEmail: req.user.email,
      title,
      instruction,
      definition: {
        connectors: connectedIds,
        steps,
        source: 'agent-chat',
        beta: true,
      },
      status,
      scheduleKind,
      hourUtc: body.hourUtc ?? 3,
      threadUid: body.threadId || null,
    });
    await syncPlaybookScheduler(pb);
    await audit(req.user.email, 'agent-playbook-create', {
      playbookUid: pb.playbook_uid, status: pb.status, scheduleKind: pb.schedule_kind, steps: steps.length,
    });
    return {
      ok: true,
      beta: true,
      playbook: pb,
      note: scheduleKind === 'daily' && status === 'active'
        ? `Scheduled daily at ${pb.hour_utc}:00 UTC via BullMQ. Worker runs agent.playbook.run.`
        : 'Saved as draft. Activate with scheduleKind=daily to run every day.',
    };
  });

  app.post('/api/agent/playbooks/:uid/activate', {
    preValidation: adminOnly,
    config: perUser(20, '1 minute'),
  }, async (req, reply) => {
    const pb = await updateAgentPlaybook(req.params.uid, req.user.email, {
      status: 'active',
      scheduleKind: 'daily',
      hourUtc: req.body?.hourUtc,
    });
    if (!pb) return reply.code(404).send({ error: 'playbook not found' });
    await syncPlaybookScheduler(pb);
    await audit(req.user.email, 'agent-playbook-activate', { playbookUid: pb.playbook_uid });
    return { ok: true, playbook: pb };
  });

  app.post('/api/agent/playbooks/:uid/pause', {
    preValidation: adminOnly,
    config: perUser(20, '1 minute'),
  }, async (req, reply) => {
    const pb = await updateAgentPlaybook(req.params.uid, req.user.email, { status: 'paused' });
    if (!pb) return reply.code(404).send({ error: 'playbook not found' });
    await syncPlaybookScheduler(pb);
    return { ok: true, playbook: pb };
  });

  app.post('/api/agent/playbooks/:uid/run', {
    preValidation: adminOnly,
    config: perUser(10, '1 minute'),
  }, async (req, reply) => {
    const pb = await getAgentPlaybook({ playbookUid: req.params.uid, userEmail: req.user.email });
    if (!pb) return reply.code(404).send({ error: 'playbook not found' });
    await enqueue('agent.playbook.run', { playbookUid: pb.playbook_uid, triggeredBy: req.user.email });
    return { ok: true, queued: true, playbookUid: pb.playbook_uid };
  });
}
