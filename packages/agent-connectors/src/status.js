// Connector status for the Connectors page + tool gating. Pure data assembly — no
// portal calls here (live probes run in the worker); this reads vault/env/OAuth state.
import {
  config, query, getUserGoogleOAuthToken, userGoogleScopeStatus, listConnectorResources,
} from '@opptra/core';
import { CONNECTOR_META } from './meta.js';

async function ucSessionMeta() {
  try {
    const { rows } = await query(
      `SELECT instance_id, status, source, updated_at, last_ok_at, needs_relogin, (jsessionid <> '') AS has_cookie
       FROM uc_session WHERE instance_id = 'india'`,
    );
    const row = rows[0];
    if (!row) return { configured: false };
    return {
      configured: true,
      instanceId: row.instance_id || 'india',
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

  const sheetResources = userEmail
    ? await listConnectorResources({ userEmail, connectorId: 'google-sheets' }).catch(() => [])
    : [];
  const driveResources = userEmail
    ? await listConnectorResources({ userEmail, connectorId: 'google-drive' }).catch(() => [])
    : [];

  return CONNECTOR_META.map((meta) => {
    const pref = prefMap[meta.id];
    let systemReady = false;
    let detail = {};
    let connectHint = '';
    let oauthUrl = null;
    let resources = [];

    if (!meta.live) {
      return {
        ...meta,
        systemReady: false,
        userEnabled: false,
        connected: false,
        status: 'coming_soon',
        connectHint: 'Coming soon',
        detail: { disabled: true },
        resources: [],
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
      resources = meta.id === 'google-sheets' ? sheetResources : driveResources;
      detail = {
        perUser: true,
        googleEmail: googleEmail || null,
        accountMismatch,
        scopes: scopeStatus,
        needsReconnect: !!userTok.refresh_token && !scopeStatus.ok,
        lastError: userTok.last_error || null,
        resourceCount: resources.length,
      };
      if (!userTok.refresh_token) {
        connectHint = 'Connect your personal Google account (OAuth)';
      } else if (!scopeStatus.ok) {
        connectHint = `Reconnect — missing scopes: ${scopeStatus.missing.join(', ')}`;
      } else if (accountMismatch) {
        connectHint = `Connected as ${googleEmail} (differs from login)`;
      } else if (!resources.length) {
        connectHint = meta.id === 'google-sheets'
          ? `Connected as ${googleEmail || 'you'} — add a spreadsheet to use with Agent`
          : `Connected as ${googleEmail || 'you'} — add a Drive folder/file to use with Agent`;
      } else {
        connectHint = `Connected as ${googleEmail || 'your Google account'} · ${resources.length} bound`;
      }
    } else if (meta.id === 'homecentre') {
      systemReady = hcReady;
      detail = { hasCreds: hcReady };
      connectHint = hcReady ? 'Vinculum creds configured' : 'Set VINCULUM_USER / VINCULUM_PASS on server';
    }

    const userEnabled = pref ? !!pref.enabled : systemReady;
    const connected = !!(systemReady && userEnabled);
    let status = 'disconnected';
    if (connected) status = 'connected';
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
      resources,
      oauthUrl,
      beta: true,
      connectEnabled: true,
    };
  });
}

/** Ids of connectors the given user can run tools against right now. */
export function connectedLiveIds(connectors) {
  return (connectors || []).filter((c) => c.connected && c.live).map((c) => c.id);
}
