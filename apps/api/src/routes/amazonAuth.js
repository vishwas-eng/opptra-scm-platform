// Amazon SP-API one-time authorization:
//   GET /auth/amazon/connect?marketplace=in|ae|sa  → Seller Central consent page
//   GET /auth/amazon/callback                      → code → refresh token → vault
//
// The seller (admin) authorizes the company account ONCE per marketplace; the platform
// holds that marketplace's refresh token in the connector vault (sealed at rest) and
// mints short-lived access tokens from it forever after. No cookies, no HAR — this is
// the official grant, so it survives password changes and never idles out.
import { config, audit, logger, setConnectorCredential, getConnectorCredentialMeta } from '@opptra/core';
import { buildConsentUrl, exchangeAuthCode, normalizeMarketplace, AMAZON_MARKETPLACES } from '@opptra/connectors-amazon';

const pendingStates = new Map(); // state -> { email, marketplace, expires }
const STATE_TTL_MS = 10 * 60_000;

function newState(email, marketplace) {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  pendingStates.set(state, { email, marketplace, expires: Date.now() + STATE_TTL_MS });
  return state;
}

function consumeState(state, email) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.email !== email || entry.expires <= Date.now()) return null;
  return entry;
}

export default async function amazonAuthRoutes(app) {
  const cfg = config();
  const adminOnly = { preValidation: app.requireRole('admin') };
  const base = () => cfg.PUBLIC_URL.replace(/\/+$/, '');

  app.get('/api/admin/amazon/status', adminOnly, async () => {
    const marketplaces = {};
    for (const id of Object.keys(AMAZON_MARKETPLACES)) {
      const meta = await getConnectorCredentialMeta('amazon', id);
      marketplaces[id] = {
        label: AMAZON_MARKETPLACES[id].label,
        connected: !!meta?.has_secret,
        sellingPartnerId: meta?.meta?.sellingPartnerId || null,
        connectedBy: meta?.updated_by || null,
        updatedAt: meta?.updated_at || null,
      };
    }
    return { appConfigured: !!(cfg.AMAZON_APP_ID && cfg.AMAZON_SP_CLIENT_ID && cfg.AMAZON_SP_CLIENT_SECRET), marketplaces };
  });

  app.get('/auth/amazon/connect', adminOnly, async (req, reply) => {
    if (!cfg.AMAZON_APP_ID || !cfg.AMAZON_SP_CLIENT_ID || !cfg.AMAZON_SP_CLIENT_SECRET) {
      return reply.code(503).send({
        error: 'Amazon SP-API app not configured (AMAZON_APP_ID / AMAZON_SP_CLIENT_ID / AMAZON_SP_CLIENT_SECRET). Create the app in Seller Central → Develop Apps first.',
      });
    }
    let marketplace;
    try {
      marketplace = normalizeMarketplace(req.query.marketplace);
    } catch (err) {
      return reply.code(400).send({ error: String(err.message) });
    }
    const url = buildConsentUrl({
      marketplace,
      applicationId: cfg.AMAZON_APP_ID,
      state: newState(req.user.email, marketplace),
      beta: cfg.AMAZON_APP_BETA,
    });
    await audit(req.user.email, 'amazon-oauth-start', { marketplace });
    return reply.redirect(url);
  });

  app.get('/auth/amazon/callback', { preValidation: app.requireUser }, async (req, reply) => {
    const fail = (msg) => reply.redirect(`${base()}/?amazonConnect=${encodeURIComponent(msg)}&tab=connectors`);

    const entry = consumeState(String(req.query.state || ''), req.user.email);
    if (!entry) return fail('state expired or mismatched — retry Connect');
    const code = String(req.query.spapi_oauth_code || '');
    if (!code) return fail('Amazon returned no authorization code');
    const sellingPartnerId = String(req.query.selling_partner_id || '');

    let grant;
    try {
      grant = await exchangeAuthCode({
        code,
        clientId: cfg.AMAZON_SP_CLIENT_ID,
        clientSecret: cfg.AMAZON_SP_CLIENT_SECRET,
      });
    } catch (err) {
      logger.error({ err: String(err.message || err), marketplace: entry.marketplace }, 'amazon oauth exchange failed');
      await audit(req.user.email, 'amazon-oauth-failed', { marketplace: entry.marketplace, error: String(err.message || err) });
      return fail('token exchange failed — check LWA client id/secret');
    }

    await setConnectorCredential({
      connectorId: 'amazon',
      ownerKey: entry.marketplace,
      authKind: 'oauth2',
      secret: grant.refreshToken,
      meta: { sellingPartnerId, marketplace: entry.marketplace },
      source: 'oauth',
      updatedBy: req.user.email,
      status: 'configured',
    });
    await audit(req.user.email, 'amazon-oauth-connected', { marketplace: entry.marketplace, sellingPartnerId });
    return reply.redirect(`${base()}/?amazonConnect=ok&marketplace=${entry.marketplace}&tab=connectors`);
  });
}
