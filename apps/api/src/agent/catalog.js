// Agent connector catalog — UI shows ALL channels; only LIVE ones can connect / run tools.
import {
  config, getGoogleOAuthToken, getConnectorSecret, query, createRun,
} from '@opptra/core';
import { createUnicommerceConnector } from '@opptra/connectors-unicommerce';
import { createAmazonConnector } from '@opptra/connectors-amazon';
import { createFlipkartConnector } from '@opptra/connectors-flipkart';
import { createMyntraConnector } from '@opptra/connectors-myntra';
import { createNykaaConnector } from '@opptra/connectors-nykaa';
import { createZeptoConnector } from '@opptra/connectors-zepto';
import { createBlinkitConnector } from '@opptra/connectors-blinkit';
import { createInstamartConnector } from '@opptra/connectors-instamart';
import { createMeeshoConnector } from '@opptra/connectors-meesho';
import { googleClients } from '@opptra/integrations-google';
import { makeVinculumClient } from '@opptra/integrations-vinculum';
import { fetchSOsFromNeon } from '@opptra/automation-sheet/waypointDb.js';
import { sanitizeResult } from '@opptra/connectors-sdk';
import { enqueue } from '../queue.js';

/** Only these may Connect / Disconnect / appear in agent tool set. */
export const LIVE_CONNECTOR_IDS = Object.freeze([
  'unicommerce',
  'waypoint',
  'google-sheets',
  'google-drive',
  'homecentre',
]);

export function isLiveConnector(id) {
  return LIVE_CONNECTOR_IDS.includes(String(id || ''));
}

export const CONNECTOR_META = [
  { id: 'unicommerce', name: 'Unicommerce', group: 'live', icon: 'UC', authKind: 'session', connectMode: 'uc-session', live: true },
  { id: 'waypoint', name: 'Waypoint', group: 'live', icon: 'WP', authKind: 'db', connectMode: 'env', live: true },
  { id: 'google-sheets', name: 'Google Sheets', group: 'live', icon: 'GS', authKind: 'oauth2', connectMode: 'google-shared', live: true },
  { id: 'google-drive', name: 'Google Drive', group: 'live', icon: 'GD', authKind: 'oauth2', connectMode: 'google-shared', live: true },
  { id: 'homecentre', name: 'Home Centre', group: 'live', icon: 'HC', authKind: 'basic', connectMode: 'env', live: true },
  // Visible but disabled (coming soon)
  { id: 'amazon', name: 'Amazon Seller Central', group: 'marketplace', icon: 'AZ', authKind: 'dual', connectMode: 'paste', live: false },
  { id: 'flipkart', name: 'Flipkart Seller Hub', group: 'marketplace', icon: 'FK', authKind: 'dual', connectMode: 'paste', live: false },
  { id: 'myntra', name: 'Myntra Partner', group: 'marketplace', icon: 'MY', authKind: 'session', connectMode: 'paste', live: false },
  { id: 'zepto', name: 'Zepto Vendor', group: 'marketplace', icon: 'ZP', authKind: 'session', connectMode: 'paste', live: false },
  { id: 'blinkit', name: 'Blinkit Seller', group: 'marketplace', icon: 'BK', authKind: 'session', connectMode: 'paste', live: false },
  { id: 'instamart', name: 'Swiggy Instamart', group: 'marketplace', icon: 'IM', authKind: 'session', connectMode: 'paste', live: false },
  { id: 'nykaa', name: 'Nykaa Seller', group: 'marketplace', icon: 'NY', authKind: 'session', connectMode: 'paste', live: false },
  { id: 'meesho', name: 'Meesho Supplier', group: 'marketplace', icon: 'MS', authKind: 'session', connectMode: 'paste', live: false },
];

async function ucSessionMeta() {
  try {
    const { rows } = await query(
      `SELECT status, source, updated_at, last_ok_at, needs_relogin, (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return { configured: false };
    return {
      configured: true,
      status: row.status,
      hasCookie: !!row.has_cookie,
      needsRelogin: !!row.needs_relogin,
      lastOkAt: row.last_ok_at,
      updatedAt: row.updated_at,
      source: row.source,
    };
  } catch {
    return { configured: false };
  }
}

export async function buildConnectorStatus(prefs = []) {
  const cfg = config();
  const prefMap = Object.fromEntries((prefs || []).map((p) => [p.connector_id, p]));
  const google = await getGoogleOAuthToken().catch(() => ({ refresh_token: '' }));
  const googleConnected = !!google.refresh_token;
  const googleSa = !!(cfg.GOOGLE_SA_EMAIL && cfg.GOOGLE_DELEGATED_USER);
  const uc = await ucSessionMeta();
  const waypointReady = !!cfg.WAYPOINT_DB_URL;
  const hcReady = !!(cfg.VINCULUM_USER && cfg.VINCULUM_PASS);

  return CONNECTOR_META.map((meta) => {
    const pref = prefMap[meta.id];
    let systemReady = false;
    let detail = {};
    let connectHint = '';

    if (!meta.live) {
      return {
        ...meta,
        systemReady: false,
        userEnabled: false,
        connected: false,
        status: 'coming_soon',
        connectHint: 'Coming soon — reverse-engineering in progress',
        detail: { disabled: true },
        beta: true,
        connectEnabled: false,
      };
    }

    if (meta.id === 'unicommerce') {
      systemReady = !!(uc.configured && uc.hasCookie && uc.status === 'alive' && !uc.needsRelogin);
      detail = { session: { status: uc.status, hasCookie: uc.hasCookie, needsRelogin: uc.needsRelogin, lastOkAt: uc.lastOkAt } };
      connectHint = systemReady ? 'UC session alive' : 'Paste JSESSIONID in Admin → Unicommerce session';
    } else if (meta.id === 'waypoint') {
      systemReady = waypointReady;
      detail = { hasDbUrl: waypointReady };
      connectHint = waypointReady ? 'Waypoint Neon DB configured' : 'Set WAYPOINT_DB_URL on server';
    } else if (meta.id === 'google-sheets' || meta.id === 'google-drive') {
      systemReady = googleConnected || googleSa;
      detail = { oauth: googleConnected, sa: googleSa };
      connectHint = systemReady ? 'Google Workspace ready' : 'Admin: connect shared Google OAuth';
    } else if (meta.id === 'homecentre') {
      systemReady = hcReady;
      detail = { hasCreds: hcReady };
      connectHint = hcReady ? 'Vinculum creds configured' : 'Set VINCULUM_USER / VINCULUM_PASS on server';
    }

    const userEnabled = pref ? !!pref.enabled : systemReady;
    const connected = !!(systemReady && userEnabled);

    return {
      ...meta,
      systemReady,
      userEnabled,
      connected,
      status: connected ? 'connected' : (systemReady ? 'ready' : 'disconnected'),
      connectHint,
      detail,
      beta: true,
      connectEnabled: true,
    };
  });
}

export function buildToolSpecs(connectedLiveIds) {
  const set = new Set(connectedLiveIds.filter(isLiveConnector));
  const tools = [];
  if (set.has('unicommerce')) {
    tools.push(
      { name: 'unicommerce_health_ping', description: 'Ping Unicommerce session health', parameters: { type: 'object', properties: {} } },
      { name: 'unicommerce_facilities_list', description: 'List UC facilities', parameters: { type: 'object', properties: {} } },
      { name: 'unicommerce_sale_order_summary', description: 'Get sale order summary', parameters: { type: 'object', properties: { saleOrder: { type: 'string' } }, required: ['saleOrder'] } },
    );
  }
  if (set.has('waypoint')) {
    tools.push({ name: 'waypoint_list_orders', description: 'List recent Waypoint sale orders', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } });
  }
  if (set.has('google-sheets')) {
    tools.push({ name: 'sheets_get_range', description: 'Read Master sheet range', parameters: { type: 'object', properties: { range: { type: 'string' }, spreadsheetId: { type: 'string' } } } });
  }
  if (set.has('google-drive')) {
    tools.push({ name: 'drive_search', description: 'Search Google Drive files', parameters: { type: 'object', properties: { query: { type: 'string' }, pageSize: { type: 'integer' } } } });
  }
  if (set.has('homecentre')) {
    tools.push(
      { name: 'homecentre_health_ping', description: 'Home Centre / Vinculum login health', parameters: { type: 'object', properties: {} } },
      { name: 'homecentre_orders_list', description: 'List active Home Centre orders', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } },
    );
  }
  return tools;
}

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
  return { ok: false, error: 'timeout waiting for worker' };
}

async function invokeUc(userEmail, action, params = {}) {
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
}

async function sharedGoogle() {
  const cfg = config();
  const oauthToken = await getGoogleOAuthToken().catch(() => null);
  if (oauthToken?.refresh_token) {
    return googleClients({
      refreshToken: oauthToken.refresh_token,
      clientId: cfg.GOOGLE_CLIENT_ID,
      clientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
      delegatedUser: oauthToken.granted_by,
    });
  }
  if ((cfg.GOOGLE_SA_KEY_JSON || cfg.GOOGLE_SA_EMAIL) && cfg.GOOGLE_DELEGATED_USER) {
    return googleClients({
      saKeyJson: cfg.GOOGLE_SA_KEY_JSON,
      saEmail: cfg.GOOGLE_SA_EMAIL,
      delegatedUser: cfg.GOOGLE_DELEGATED_USER,
    });
  }
  return null;
}

export function makeToolExecutor({ userEmail, connectedIds }) {
  const set = new Set((connectedIds || []).filter(isLiveConnector));
  const cfg = config();
  const need = (id) => {
    if (!isLiveConnector(id)) return { ok: false, error: `${id} is coming soon and cannot be used yet.` };
    if (!set.has(id)) return { ok: false, error: `Connect ${id} in the Agent connectors panel first.` };
    return null;
  };

  return async function executeTool(name, args = {}) {
    if (name.startsWith('unicommerce_')) {
      const blocked = need('unicommerce');
      if (blocked) return blocked;
      if (name === 'unicommerce_health_ping') return sanitizeResult(await invokeUc(userEmail, 'health.ping'));
      if (name === 'unicommerce_facilities_list') return sanitizeResult(await invokeUc(userEmail, 'facilities.list'));
      if (name === 'unicommerce_sale_order_summary') {
        return sanitizeResult(await invokeUc(userEmail, 'saleOrder.getSummary', { saleOrder: args.saleOrder }));
      }
    }
    if (name === 'waypoint_list_orders') {
      const blocked = need('waypoint');
      if (blocked) return blocked;
      if (!cfg.WAYPOINT_DB_URL) return { ok: false, error: 'WAYPOINT_DB_URL not configured' };
      const rows = await fetchSOsFromNeon(cfg.WAYPOINT_DB_URL);
      const limit = Math.min(Number(args.limit) || 20, 50);
      return sanitizeResult({ ok: true, count: rows.length, orders: rows.slice(0, limit) });
    }
    if (name === 'sheets_get_range') {
      const blocked = need('google-sheets');
      if (blocked) return blocked;
      const g = await sharedGoogle();
      if (!g?.sheets) return { ok: false, error: 'Google Sheets not connected' };
      const spreadsheetId = args.spreadsheetId || cfg.MASTER_SHEET_ID;
      const range = args.range || 'Master!A1:G20';
      const res = await g.sheets.spreadsheets.values.get({ spreadsheetId, range });
      return sanitizeResult({ ok: true, range, values: (res.data.values || []).slice(0, 40) });
    }
    if (name === 'drive_search') {
      const blocked = need('google-drive');
      if (blocked) return blocked;
      const g = await sharedGoogle();
      if (!g?.drive) return { ok: false, error: 'Google Drive not connected' };
      const res = await g.drive.files.list({
        q: args.query || "mimeType != 'application/vnd.google-apps.folder'",
        pageSize: Math.min(Number(args.pageSize) || 10, 25),
        fields: 'files(id,name,mimeType,modifiedTime)',
      });
      return sanitizeResult({ ok: true, files: res.data.files || [] });
    }
    if (name.startsWith('homecentre_')) {
      const blocked = need('homecentre');
      if (blocked) return blocked;
      if (!cfg.VINCULUM_USER || !cfg.VINCULUM_PASS) {
        return { ok: false, error: 'VINCULUM_USER / VINCULUM_PASS not configured' };
      }
      try {
        const client = makeVinculumClient({
          baseUrl: cfg.VINCULUM_BASE_URL,
          userName: cfg.VINCULUM_USER,
          password: cfg.VINCULUM_PASS,
        });
        if (name === 'homecentre_health_ping') {
          await client.login();
          return sanitizeResult({ ok: true, backend: 'vinculum', portal: 'Home Centre' });
        }
        if (name === 'homecentre_orders_list') {
          const limit = Math.min(Number(args.limit) || 20, 50);
          const data = await client.listActiveOrders({ page: 1, rows: limit });
          return sanitizeResult({
            ok: true,
            count: data.orders?.length || 0,
            records: data.records,
            orders: (data.orders || []).slice(0, limit),
          });
        }
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }
    // Explicit reject for marketplace tools even if somehow requested
    if (/^(amazon|flipkart|myntra|nykaa|zepto|blinkit|instamart|meesho)_/.test(name)) {
      return { ok: false, error: 'This marketplace connector is coming soon and cannot be used yet.' };
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  };
}

/** Capability catalog for docs/debug — includes disabled connectors' planned actions. */
export function listAllCapabilities() {
  const cfg = config();
  const caps = [];
  const push = (connectorId, list, live) => {
    for (const c of list) caps.push({ connectorId, live, ...c });
  };
  push('unicommerce', createUnicommerceConnector({
    uc: { ping: async () => ({ alive: false }), listFacilities: async () => ({ all: [], current: null }), data: async () => ({}), public: async () => ({}) },
  }).listCapabilities(), true);
  push('amazon', createAmazonConnector({ cfg }).listCapabilities(), false);
  push('flipkart', createFlipkartConnector({ cfg }).listCapabilities(), false);
  push('myntra', createMyntraConnector({}).listCapabilities(), false);
  push('nykaa', createNykaaConnector({}).listCapabilities(), false);
  push('zepto', createZeptoConnector({}).listCapabilities(), false);
  push('blinkit', createBlinkitConnector({}).listCapabilities(), false);
  push('instamart', createInstamartConnector({}).listCapabilities(), false);
  push('meesho', createMeeshoConnector({}).listCapabilities(), false);
  return caps;
}
