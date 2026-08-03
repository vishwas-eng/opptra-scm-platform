// Agent connector catalog — UI shows ALL channels; only LIVE ones can connect / run tools.
import {
  config, getUserGoogleOAuthToken, getConnectorSecret, query, createRun,
  markUserGoogleOAuthError, markUserGoogleOAuthOk, userGoogleScopeStatus,
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
import { googleClients, sheetsApi, driveApi } from '@opptra/integrations-google';
import { makeVinculumClient } from '@opptra/integrations-vinculum';
import { fetchSOsFromNeon } from '@opptra/automation-sheet/waypointDb.js';
import { sanitizeResult } from '@opptra/connectors-sdk';
import { enqueue } from '../queue.js';

/** Only these may Connect / Disconnect / appear in agent tool set. */
export const LIVE_CONNECTOR_IDS = Object.freeze([
  'google-sheets',
  'google-drive',
  'unicommerce',
  'waypoint',
  'homecentre',
]);

export function isLiveConnector(id) {
  return LIVE_CONNECTOR_IDS.includes(String(id || ''));
}

export const CONNECTOR_META = [
  { id: 'google-sheets', name: 'Google Sheets', group: 'live', icon: 'GS', authKind: 'oauth2', connectMode: 'google-user', live: true, blurb: 'Read & write your spreadsheets' },
  { id: 'google-drive', name: 'Google Drive', group: 'live', icon: 'GD', authKind: 'oauth2', connectMode: 'google-user', live: true, blurb: 'Search & download your Drive files' },
  { id: 'unicommerce', name: 'Unicommerce', group: 'live', icon: 'UC', authKind: 'session', connectMode: 'uc-session', live: true, blurb: 'OMS session health & orders' },
  { id: 'waypoint', name: 'Waypoint', group: 'live', icon: 'WP', authKind: 'db', connectMode: 'env', live: true, blurb: 'Sale-order source of truth' },
  { id: 'homecentre', name: 'Home Centre', group: 'live', icon: 'HC', authKind: 'basic', connectMode: 'env', live: true, blurb: 'Vinculum seller portal' },
  { id: 'amazon', name: 'Amazon Seller Central', group: 'marketplace', icon: 'AZ', authKind: 'dual', connectMode: 'paste', live: false, blurb: 'Seller Central / SP-API' },
  { id: 'flipkart', name: 'Flipkart Seller Hub', group: 'marketplace', icon: 'FK', authKind: 'dual', connectMode: 'paste', live: false, blurb: 'Seller Hub / Seller API' },
  { id: 'myntra', name: 'Myntra Partner', group: 'marketplace', icon: 'MY', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Partner portal + ASN' },
  { id: 'zepto', name: 'Zepto Vendor', group: 'marketplace', icon: 'ZP', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Vendor portal' },
  { id: 'blinkit', name: 'Blinkit Seller', group: 'marketplace', icon: 'BK', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Quick-commerce seller' },
  { id: 'instamart', name: 'Swiggy Instamart', group: 'marketplace', icon: 'IM', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Partner portal' },
  { id: 'nykaa', name: 'Nykaa Seller', group: 'marketplace', icon: 'NY', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Seller portal' },
  { id: 'meesho', name: 'Meesho Supplier', group: 'marketplace', icon: 'MS', authKind: 'session', connectMode: 'paste', live: false, blurb: 'Supplier portal' },
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

export async function buildConnectorStatus(prefs = [], { userEmail = '' } = {}) {
  const cfg = config();
  const prefMap = Object.fromEntries((prefs || []).map((p) => [p.connector_id, p]));
  const uc = await ucSessionMeta();
  const waypointReady = !!cfg.WAYPOINT_DB_URL;
  const hcReady = !!(cfg.VINCULUM_USER && cfg.VINCULUM_PASS);

  // Agent Sheets/Drive = per-user OAuth only (never shared SA).
  const userTok = userEmail
    ? await getUserGoogleOAuthToken(userEmail).catch(() => ({ refresh_token: '' }))
    : { refresh_token: '' };
  const scopeStatus = userGoogleScopeStatus(userTok.scope);
  const googleEmail = String(userTok.google_email || userTok.granted_by || '').toLowerCase();
  const accountMismatch = !!(googleEmail && userEmail && googleEmail !== String(userEmail).toLowerCase());
  const userGoogleReady = !!(userTok.refresh_token && scopeStatus.ok);

  return CONNECTOR_META.map((meta) => {
    const pref = prefMap[meta.id];
    let systemReady = false;
    let detail = {};
    let connectHint = '';
    let oauthUrl = null;

    if (!meta.live) {
      return {
        ...meta,
        systemReady: false,
        userEnabled: false,
        connected: false,
        status: 'coming_soon',
        connectHint: 'Coming soon',
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
      systemReady = userGoogleReady;
      oauthUrl = '/auth/google/connect?return=connectors';
      detail = {
        perUser: true,
        googleEmail: googleEmail || null,
        accountMismatch,
        scopes: scopeStatus,
        needsReconnect: !!userTok.refresh_token && !scopeStatus.ok,
        lastError: userTok.last_error || null,
      };
      if (!userTok.refresh_token) {
        connectHint = 'Connect your personal Google account (OAuth)';
      } else if (!scopeStatus.ok) {
        connectHint = `Reconnect — missing scopes: ${scopeStatus.missing.join(', ')}`;
      } else if (accountMismatch) {
        connectHint = `Connected as ${googleEmail} (differs from login)`;
      } else {
        connectHint = `Connected as ${googleEmail || 'your Google account'}`;
      }
    } else if (meta.id === 'homecentre') {
      systemReady = hcReady;
      detail = { hasCreds: hcReady };
      connectHint = hcReady ? 'Vinculum creds configured' : 'Set VINCULUM_USER / VINCULUM_PASS on server';
    }

    const userEnabled = pref ? !!pref.enabled : systemReady;
    const connected = !!(systemReady && userEnabled);
    let status = 'disconnected';
    if (!meta.live) status = 'coming_soon';
    else if (connected) status = 'connected';
    else if (detail.needsReconnect) status = 'needs_reconnect';
    else if (systemReady) status = 'ready';

    return {
      ...meta,
      systemReady,
      userEnabled,
      connected,
      status,
      connectHint,
      detail,
      oauthUrl,
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
    tools.push(
      { name: 'sheets_list_spreadsheets', description: 'List recent Google Spreadsheets visible to the connected account', parameters: { type: 'object', properties: { pageSize: { type: 'integer' }, nameContains: { type: 'string' } } } },
      { name: 'sheets_list_tabs', description: 'List tab names in a spreadsheet', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' } }, required: ['spreadsheetId'] } },
      { name: 'sheets_get_range', description: 'Read values from a sheet range (A1 notation)', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, required: ['range'] } },
      { name: 'sheets_update_range', description: 'Write/overwrite values into a sheet range (USER_ENTERED). values = 2D array of rows.', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array' } }, required: ['range', 'values'] } },
      { name: 'sheets_append_rows', description: 'Append rows to a sheet tab/range', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array' } }, required: ['range', 'values'] } },
      { name: 'sheets_copy_range', description: 'Copy values from one range to another (sheet→sheet). Same or different spreadsheet IDs.', parameters: { type: 'object', properties: { sourceSpreadsheetId: { type: 'string' }, sourceRange: { type: 'string' }, destSpreadsheetId: { type: 'string' }, destRange: { type: 'string' } }, required: ['sourceRange', 'destRange'] } },
    );
  }
  if (set.has('google-drive')) {
    tools.push(
      { name: 'drive_search', description: 'Search Drive files by name/query', parameters: { type: 'object', properties: { query: { type: 'string' }, nameContains: { type: 'string' }, pageSize: { type: 'integer' } } } },
      { name: 'drive_list_folder', description: 'List files in a Drive folder id', parameters: { type: 'object', properties: { folderId: { type: 'string' }, pageSize: { type: 'integer' } }, required: ['folderId'] } },
      { name: 'drive_get_file_meta', description: 'Get Drive file metadata (id, name, mime, size, modified)', parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } },
      { name: 'drive_read_text_file', description: 'Download a small text/csv/json Drive file and return a text preview (truncated)', parameters: { type: 'object', properties: { fileId: { type: 'string' }, maxChars: { type: 'integer' } }, required: ['fileId'] } },
    );
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

async function agentGoogleFor(userEmail) {
  const cfg = config();
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return null;
  const tok = await getUserGoogleOAuthToken(email).catch(() => null);
  if (!tok?.refresh_token) return null;
  const scopes = userGoogleScopeStatus(tok.scope);
  if (!scopes.ok) {
    const err = new Error(`Google reconnect required — missing scopes: ${scopes.missing.join(', ')}`);
    err.code = 'GOOGLE_SCOPES';
    throw err;
  }
  try {
    const clients = await googleClients({
      refreshToken: tok.refresh_token,
      clientId: cfg.GOOGLE_CLIENT_ID,
      clientSecret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
      delegatedUser: tok.google_email || tok.granted_by || email,
    });
    await markUserGoogleOAuthOk(email).catch(() => {});
    return { ...clients, googleEmail: tok.google_email || tok.granted_by || email };
  } catch (err) {
    const msg = String(err.message || err);
    if (/invalid_grant|Token has been expired or revoked|revoked/i.test(msg)) {
      await markUserGoogleOAuthError(email, 'refresh token revoked — reconnect Google').catch(() => {});
      const e = new Error('Google access revoked. Open Connectors → Google Sheets → Connect again.');
      e.code = 'GOOGLE_REVOKED';
      throw e;
    }
    await markUserGoogleOAuthError(email, msg.slice(0, 400)).catch(() => {});
    throw err;
  }
}

function mapGoogleToolError(err) {
  const msg = String(err?.message || err);
  const code = err?.code || err?.response?.status;
  if (err?.code === 'GOOGLE_REVOKED' || err?.code === 'GOOGLE_SCOPES') {
    return { ok: false, error: msg, reconnect: true, oauthUrl: '/auth/google/connect?return=connectors' };
  }
  if (code === 401 || /invalid_grant|revoked/i.test(msg)) {
    return { ok: false, error: 'Google token invalid. Reconnect in Connectors.', reconnect: true, oauthUrl: '/auth/google/connect?return=connectors' };
  }
  if (code === 403 || /PERMISSION_DENIED|insufficientPermissions|The caller does not have permission/i.test(msg)) {
    return {
      ok: false,
      error: 'Permission denied — you can see this file but cannot edit it, or scopes are missing. Share edit access or reconnect Google with Sheets+Drive.',
      permissionDenied: true,
    };
  }
  if (code === 429 || /rateLimit|quota|userRateLimit/i.test(msg)) {
    return { ok: false, error: 'Google API rate limit — wait a minute and retry.', rateLimited: true };
  }
  return { ok: false, error: msg };
}

export function makeToolExecutor({ userEmail, connectedIds }) {
  const set = new Set((connectedIds || []).filter(isLiveConnector));
  const cfg = config();
  const need = (id) => {
    if (!isLiveConnector(id)) return { ok: false, error: `${id} is coming soon and cannot be used yet.` };
    if (!set.has(id)) return { ok: false, error: `Connect ${id} in the Agent connectors panel first.` };
    return null;
  };

  function clampRows(values) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, 200).map((row) => {
      if (!Array.isArray(row)) return [String(row ?? '')];
      return row.slice(0, 50).map((c) => (c == null ? '' : String(c).slice(0, 500)));
    });
  }

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
    if (name.startsWith('sheets_') || name === 'sheets_get_range') {
      const blocked = need('google-sheets');
      if (blocked) return blocked;
      let g;
      try { g = await agentGoogleFor(userEmail); }
      catch (err) { return mapGoogleToolError(err); }
      if (!g?.sheets) return { ok: false, error: 'Connect your Google account in Connectors (Sheets)', reconnect: true, oauthUrl: '/auth/google/connect?return=connectors' };
      const sid = args.spreadsheetId || cfg.MASTER_SHEET_ID;
      try {
        if (name === 'sheets_list_spreadsheets') {
          if (!g.drive) return { ok: false, error: 'Drive scope missing — reconnect Google' };
          const nameQ = args.nameContains ? ` and name contains '${String(args.nameContains).replace(/'/g, "\\'")}'` : '';
          const res = await g.drive.files.list({
            q: `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false${nameQ}`,
            pageSize: Math.min(Number(args.pageSize) || 20, 50),
            fields: 'files(id,name,modifiedTime)',
            orderBy: 'modifiedTime desc',
          });
          return sanitizeResult({ ok: true, googleEmail: g.googleEmail, spreadsheets: res.data.files || [] });
        }
        if (name === 'sheets_list_tabs') {
          const tabs = await sheetsApi.listTabs(g.sheets, args.spreadsheetId || sid);
          return sanitizeResult({ ok: true, spreadsheetId: args.spreadsheetId || sid, tabs });
        }
        if (name === 'sheets_get_range') {
          const range = args.range || 'Master!A1:G20';
          const values = await sheetsApi.read(g.sheets, sid, range);
          return sanitizeResult({ ok: true, spreadsheetId: sid, range, values: values.slice(0, 80) });
        }
        if (name === 'sheets_update_range') {
          const values = clampRows(args.values);
          if (!values.length) return { ok: false, error: 'values required (2D array)' };
          await sheetsApi.update(g.sheets, sid, args.range, values);
          return sanitizeResult({ ok: true, spreadsheetId: sid, range: args.range, rowsWritten: values.length });
        }
        if (name === 'sheets_append_rows') {
          const values = clampRows(args.values);
          if (!values.length) return { ok: false, error: 'values required (2D array)' };
          await sheetsApi.append(g.sheets, sid, args.range, values);
          return sanitizeResult({ ok: true, spreadsheetId: sid, range: args.range, rowsAppended: values.length });
        }
        if (name === 'sheets_copy_range') {
          const srcId = args.sourceSpreadsheetId || sid;
          const dstId = args.destSpreadsheetId || sid;
          const values = await sheetsApi.read(g.sheets, srcId, args.sourceRange);
          const clipped = clampRows(values);
          if (!clipped.length) return { ok: false, error: 'source range empty' };
          await sheetsApi.update(g.sheets, dstId, args.destRange, clipped);
          return sanitizeResult({
            ok: true, sourceSpreadsheetId: srcId, sourceRange: args.sourceRange,
            destSpreadsheetId: dstId, destRange: args.destRange, rowsCopied: clipped.length,
          });
        }
      } catch (err) {
        return mapGoogleToolError(err);
      }
    }
    if (name.startsWith('drive_')) {
      const blocked = need('google-drive');
      if (blocked) return blocked;
      let g;
      try { g = await agentGoogleFor(userEmail); }
      catch (err) { return mapGoogleToolError(err); }
      if (!g?.drive) return { ok: false, error: 'Connect your Google account in Connectors (Drive)', reconnect: true, oauthUrl: '/auth/google/connect?return=connectors' };
      try {
        if (name === 'drive_search') {
          let q = args.query || "mimeType != 'application/vnd.google-apps.folder' and trashed = false";
          if (args.nameContains) q = `name contains '${String(args.nameContains).replace(/'/g, "\\'")}' and trashed = false`;
          const res = await g.drive.files.list({
            q,
            pageSize: Math.min(Number(args.pageSize) || 15, 40),
            fields: 'files(id,name,mimeType,modifiedTime,size)',
            orderBy: 'modifiedTime desc',
          });
          return sanitizeResult({ ok: true, googleEmail: g.googleEmail, files: res.data.files || [] });
        }
        if (name === 'drive_list_folder') {
          const files = await driveApi.listFolder(g.drive, args.folderId);
          return sanitizeResult({ ok: true, folderId: args.folderId, files: files.slice(0, Math.min(Number(args.pageSize) || 50, 100)) });
        }
        if (name === 'drive_get_file_meta') {
          const res = await g.drive.files.get({
            fileId: args.fileId,
            fields: 'id,name,mimeType,modifiedTime,size,parents,webViewLink',
          });
          return sanitizeResult({ ok: true, file: res.data });
        }
        if (name === 'drive_read_text_file') {
          const meta = await g.drive.files.get({ fileId: args.fileId, fields: 'id,name,mimeType,size' });
          const mime = meta.data.mimeType || '';
          const maxChars = Math.min(Number(args.maxChars) || 8000, 20000);
          let buf;
          if (mime === 'application/vnd.google-apps.document') {
            const res = await g.drive.files.export({ fileId: args.fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
            buf = Buffer.from(res.data);
          } else if (mime === 'application/vnd.google-apps.spreadsheet') {
            const res = await g.drive.files.export({ fileId: args.fileId, mimeType: 'text/csv' }, { responseType: 'arraybuffer' });
            buf = Buffer.from(res.data);
          } else if (/^text\/|json|csv|xml/i.test(mime) || /\.(csv|txt|json|tsv)$/i.test(meta.data.name || '')) {
            buf = await driveApi.getFileBytes(g.drive, args.fileId);
          } else {
            return { ok: false, error: `Cannot preview binary type ${mime}. Use drive_get_file_meta.` };
          }
          const text = buf.toString('utf8');
          return sanitizeResult({
            ok: true,
            file: { id: meta.data.id, name: meta.data.name, mimeType: mime, size: meta.data.size },
            text: text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text,
            truncated: text.length > maxChars,
          });
        }
      } catch (err) {
        return mapGoogleToolError(err);
      }
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
