// Per-user Google OAuth resolution + error mapping for Agent tools.
//
// Agent Sheets/Drive tools use ONLY the signed-in user's own OAuth grant — never the
// platform's shared refresh token or service account. That keeps the ACL honest: the
// Agent can touch exactly what the human could touch in their own browser, nothing more.
import {
  config, getUserGoogleOAuthToken, markUserGoogleOAuthError, markUserGoogleOAuthOk,
  userGoogleScopeStatus,
} from '@opptra/core';
import { googleClients } from '@opptra/integrations-google';
import { CONNECTOR_ERROR_CODES, connectorError } from '@opptra/connectors-sdk';

export const GOOGLE_RECONNECT_URL = '/auth/google/connect?return=connectors';

/**
 * Resolve authorized googleapis clients for a user, or throw a coded error.
 * Errors carry `.code` = 'GOOGLE_SCOPES' | 'GOOGLE_REVOKED' for mapGoogleToolError.
 */
export async function agentGoogleFor(userEmail) {
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

/** Map a googleapis / auth failure to the shared connector error shape. */
export function mapGoogleToolError(err) {
  const msg = String(err?.message || err);
  const status = err?.code || err?.response?.status;
  if (err?.code === 'GOOGLE_REVOKED') {
    return connectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED, msg, {
      reconnect: true, oauthUrl: GOOGLE_RECONNECT_URL,
    });
  }
  if (err?.code === 'GOOGLE_SCOPES') {
    return connectorError(CONNECTOR_ERROR_CODES.SCOPE_MISSING, msg, {
      reconnect: true, oauthUrl: GOOGLE_RECONNECT_URL,
    });
  }
  if (status === 401 || /invalid_grant|revoked/i.test(msg)) {
    return connectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED,
      'Google token invalid. Reconnect in Connectors.',
      { reconnect: true, oauthUrl: GOOGLE_RECONNECT_URL });
  }
  if (status === 404 || /File not found|Requested entity was not found/i.test(msg)) {
    return connectorError(CONNECTOR_ERROR_CODES.NOT_FOUND,
      'Google says that file/sheet does not exist (or your account cannot see it). Check the link and the connected Google account.');
  }
  if (status === 403 || /PERMISSION_DENIED|insufficientPermissions|The caller does not have permission/i.test(msg)) {
    return connectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED,
      'Permission denied — you can see this file but cannot edit it, or scopes are missing. Share edit access or reconnect Google with Sheets+Drive.',
      { permissionDenied: true });
  }
  if (status === 429 || /rateLimit|quota|userRateLimit/i.test(msg)) {
    return connectorError(CONNECTOR_ERROR_CODES.RATE_LIMITED,
      'Google API rate limit — wait a minute and retry.',
      { rateLimited: true });
  }
  return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, msg);
}

/** Escape a user-supplied string for a Drive `q` query single-quoted literal. */
export function escapeDriveQuery(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
