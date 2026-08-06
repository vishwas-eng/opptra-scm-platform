// Google Workspace OAuth:
//   - /auth/google/connect        → per-user (Packing Mail + Agent Sheets/Drive)
//   - /auth/google/connect-shared → admin-only shared grant (platform Sheet Update)
// Agent tools MUST use per-user tokens; shared/SA stays for platform automations only.
import { OAuth2Client } from 'google-auth-library';
import {
  config, audit, logger,
  setGoogleOAuthToken, getGoogleOAuthToken,
  setUserGoogleOAuthToken, getUserGoogleOAuthToken, clearUserGoogleOAuthToken,
  userGoogleScopeStatus,
} from '@opptra/core';
import { SCOPES } from '@opptra/integrations-google';

const pendingStates = new Map(); // state -> { email, purpose, returnTab, expires }
const STATE_TTL_MS = 10 * 60_000;

function newState(email, purpose = 'user', returnTab = '') {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  pendingStates.set(state, {
    email, purpose, returnTab: returnTab || '', expires: Date.now() + STATE_TTL_MS,
  });
  return state;
}
function consumeState(state, email) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.email !== email || entry.expires <= Date.now()) return null;
  return entry;
}

export default async function googleAuthRoutes(app) {
  const cfg = config();
  const redirectUri = () => `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/auth/google/callback`;
  const opsOrAdmin = app.requireRole('admin', 'ops');

  app.get('/api/admin/google/status', { preValidation: app.requireRole('admin') }, async () => {
    const t = await getGoogleOAuthToken();
    return { connected: !!t.refresh_token, grantedBy: t.granted_by || null, updatedAt: t.updated_at || null };
  });

  app.get('/api/me/google/status', { preValidation: opsOrAdmin }, async (req) => {
    const t = await getUserGoogleOAuthToken(req.user.email);
    const scopes = userGoogleScopeStatus(t.scope);
    const googleEmail = (t.google_email || t.granted_by || '').toLowerCase();
    const accountMismatch = !!(googleEmail && googleEmail !== req.user.email.toLowerCase());
    return {
      connected: !!t.refresh_token && scopes.ok,
      hasToken: !!t.refresh_token,
      grantedBy: t.granted_by || null,
      googleEmail: googleEmail || null,
      accountMismatch,
      scopes,
      needsReconnect: !!t.refresh_token && !scopes.ok,
      lastError: t.last_error || null,
      updatedAt: t.updated_at || null,
      email: req.user.email,
      redirectUri: redirectUri(),
      connectUrl: '/auth/google/connect?return=connectors',
    };
  });

  app.post('/api/me/google/disconnect', { preValidation: opsOrAdmin }, async (req) => {
    await clearUserGoogleOAuthToken(req.user.email);
    await audit(req.user.email, 'google-oauth-user-disconnected', {});
    return { ok: true };
  });

  // Per-user connect (Packing Mail + Agent Sheets/Drive). ?return=connectors|packing|agent
  app.get('/auth/google/connect', { preValidation: opsOrAdmin }, async (req, reply) => {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply.code(400).send({ error: 'GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server.' });
    }
    const returnTab = String(req.query.return || req.query.tab || 'connectors').replace(/[^a-z]/gi, '') || 'connectors';
    const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force refresh_token every time (Google omits it on silent re-auth)
      include_granted_scopes: true,
      scope: ['openid', 'email', 'profile', ...SCOPES],
      login_hint: req.user.email,
      state: newState(req.user.email, 'user', returnTab),
    });
    return reply.redirect(url);
  });

  app.get('/auth/google/connect-shared', { preValidation: app.requireRole('admin') }, async (req, reply) => {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply.code(400).send({ error: 'GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server.' });
    }
    const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['openid', 'email', ...SCOPES],
      state: newState(req.user.email, 'shared', 'admin'),
    });
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', { preValidation: opsOrAdmin }, async (req, reply) => {
    const { code, state, error } = req.query;
    const base = cfg.PUBLIC_URL.replace(/\/+$/, '');
    const failTo = (msg, tab = 'connectors') =>
      reply.redirect(`${base}/?googleConnect=${encodeURIComponent(String(msg))}&tab=${encodeURIComponent(tab)}`);
    if (error) return failTo(error, 'connectors');
    const entry = code && state ? consumeState(state, req.user.email) : null;
    if (!entry) {
      return failTo(
        'invalid or expired OAuth state (open Connect from one tab only, then retry)',
        'connectors',
      );
    }
    const tab = entry.returnTab || (entry.purpose === 'shared' ? 'admin' : 'connectors');
    try {
      const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) {
        return failTo(
          'Google did not return a refresh token, revoke Opptra at myaccount.google.com/permissions then Connect again',
          tab,
        );
      }
      let grantedBy = req.user.email;
      if (tokens.id_token) {
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.GOOGLE_CLIENT_ID });
        grantedBy = ticket.getPayload()?.email || req.user.email;
      }
      const scope = tokens.scope || SCOPES.join(' ');
      const scopeStatus = userGoogleScopeStatus(scope);

      if (entry.purpose === 'shared') {
        await setGoogleOAuthToken({ refreshToken: tokens.refresh_token, grantedBy, scope });
        await audit(req.user.email, 'google-oauth-shared-connected', { grantedBy });
        logger.info({ grantedBy }, 'shared google workspace connected (sheets)');
        return reply.redirect(`${base}/?googleConnect=ok&tab=admin`);
      }

      await setUserGoogleOAuthToken({
        userEmail: req.user.email,
        refreshToken: tokens.refresh_token,
        grantedBy,
        scope,
        googleEmail: grantedBy,
      });
      await audit(req.user.email, 'google-oauth-user-connected', { grantedBy, scopeStatus });
      logger.info({ user: req.user.email, grantedBy }, 'user google workspace connected (packing + agent)');

      if (!scopeStatus.ok) {
        return failTo(
          `connected but missing scopes: ${scopeStatus.missing.join(', ')}, disconnect and reconnect granting Sheets + Drive`,
          tab,
        );
      }
      const mismatch = grantedBy.toLowerCase() !== req.user.email.toLowerCase()
        ? `&googleMismatch=1&googleAccount=${encodeURIComponent(grantedBy)}`
        : '';
      return reply.redirect(`${base}/?googleConnect=ok&tab=${encodeURIComponent(tab)}${mismatch}`);
    } catch (err) {
      logger.error({ err: String(err) }, 'google oauth callback failed');
      return failTo('connection failed: ' + (err.message || err), tab);
    }
  });
}
