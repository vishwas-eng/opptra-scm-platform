// Google Workspace OAuth:
//   - /auth/google/connect        → any ops/admin connects THEIR Gmail (Packing Mail)
//   - /auth/google/connect-shared → admin-only shared grant (Sheet Update / Drive sheets)
// Org "Internal" OAuth consent screen: any @opptra.com account can grant without Google verification.
import { OAuth2Client } from 'google-auth-library';
import {
  config, audit, logger,
  setGoogleOAuthToken, getGoogleOAuthToken,
  setUserGoogleOAuthToken, getUserGoogleOAuthToken, clearUserGoogleOAuthToken,
} from '@opptra/core';
import { SCOPES } from '@opptra/integrations-google';

const pendingStates = new Map(); // state -> { email, purpose, expires }
const STATE_TTL_MS = 10 * 60_000;
function newState(email, purpose = 'user') {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  pendingStates.set(state, { email, purpose, expires: Date.now() + STATE_TTL_MS });
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

  // Shared (admin) status — Sheet Update / org Drive-Sheets.
  app.get('/api/admin/google/status', { preValidation: app.requireRole('admin') }, async () => {
    const t = await getGoogleOAuthToken();
    return { connected: !!t.refresh_token, grantedBy: t.granted_by || null, updatedAt: t.updated_at || null };
  });

  // Per-user status — Packing Mail drafts/sends from this user's Gmail.
  app.get('/api/me/google/status', { preValidation: opsOrAdmin }, async (req) => {
    const t = await getUserGoogleOAuthToken(req.user.email);
    return {
      connected: !!t.refresh_token,
      grantedBy: t.granted_by || null,
      updatedAt: t.updated_at || null,
      email: req.user.email,
    };
  });

  app.post('/api/me/google/disconnect', { preValidation: opsOrAdmin }, async (req) => {
    await clearUserGoogleOAuthToken(req.user.email);
    await audit(req.user.email, 'google-oauth-user-disconnected', {});
    return { ok: true };
  });

  // Per-user connect (Packing Mail).
  app.get('/auth/google/connect', { preValidation: opsOrAdmin }, async (req, reply) => {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply.code(400).send({ error: 'GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server.' });
    }
    const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['openid', 'email', ...SCOPES],
      // Prefer the same Google account they signed into the app with.
      login_hint: req.user.email,
      state: newState(req.user.email, 'user'),
    });
    return reply.redirect(url);
  });

  // Shared admin connect (Sheet Update writes).
  app.get('/auth/google/connect-shared', { preValidation: app.requireRole('admin') }, async (req, reply) => {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply.code(400).send({ error: 'GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server.' });
    }
    const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['openid', 'email', ...SCOPES],
      state: newState(req.user.email, 'shared'),
    });
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', { preValidation: opsOrAdmin }, async (req, reply) => {
    const { code, state, error } = req.query;
    const base = cfg.PUBLIC_URL.replace(/\/+$/, '');
    const failTo = (msg, tab = '') => reply.redirect(`${base}/?googleConnect=${encodeURIComponent(String(msg))}${tab ? `&tab=${tab}` : ''}`);
    if (error) return failTo(error);
    const entry = code && state ? consumeState(state, req.user.email) : null;
    if (!entry) return failTo('invalid or expired request, try again');
    const tab = entry.purpose === 'user' ? 'packing' : '';
    try {
      const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri());
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) {
        return failTo(
          'Google did not return a refresh token - try disconnecting any prior grant at myaccount.google.com/permissions and reconnecting',
          tab,
        );
      }
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.GOOGLE_CLIENT_ID });
      const grantedBy = ticket.getPayload()?.email || req.user.email;
      if (entry.purpose === 'shared') {
        await setGoogleOAuthToken({ refreshToken: tokens.refresh_token, grantedBy, scope: SCOPES.join(' ') });
        await audit(req.user.email, 'google-oauth-shared-connected', { grantedBy });
        logger.info({ grantedBy }, 'shared google workspace connected (sheets)');
        return reply.redirect(`${base}/?googleConnect=ok&tab=admin`);
      }
      await setUserGoogleOAuthToken({
        userEmail: req.user.email,
        refreshToken: tokens.refresh_token,
        grantedBy,
        scope: SCOPES.join(' '),
      });
      await audit(req.user.email, 'google-oauth-user-connected', { grantedBy });
      logger.info({ user: req.user.email, grantedBy }, 'user google workspace connected (packing mail)');
      return reply.redirect(`${base}/?googleConnect=ok&tab=packing`);
    } catch (err) {
      logger.error({ err: String(err) }, 'google oauth callback failed');
      return failTo('connection failed: ' + (err.message || err), tab);
    }
  });
}
