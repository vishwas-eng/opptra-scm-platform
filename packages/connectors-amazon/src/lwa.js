// Login-with-Amazon plumbing for SP-API, the "connect once, hold the refresh token
// forever" flow. One LWA application (client id/secret) serves every marketplace; the
// seller authorizes once per Seller Central region and we keep that region's refresh
// token in the connector vault.
//
// Flow: buildConsentUrl() → seller approves on Amazon's own page → Amazon redirects to
// our callback with spapi_oauth_code → exchangeAuthCode() → { refresh_token,
// selling_partner_id } → vault. Access tokens are minted from the refresh token on
// demand (~1 h validity) and cached to ~55 min.

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** Marketplaces Opptra sells on. All three ride the EU SP-API endpoint. */
export const AMAZON_MARKETPLACES = Object.freeze({
  in: { marketplaceId: 'A21TJRUUN4KGV', sellerCentral: 'https://sellercentral.amazon.in', label: 'Amazon India' },
  ae: { marketplaceId: 'A2VIGQ35RCS4UG', sellerCentral: 'https://sellercentral.amazon.ae', label: 'Amazon UAE' },
  sa: { marketplaceId: 'A17E79C6D8DWNP', sellerCentral: 'https://sellercentral.amazon.sa', label: 'Amazon KSA' },
});

export const SP_API_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com';

export function normalizeMarketplace(m) {
  const id = String(m || 'in').trim().toLowerCase();
  if (!AMAZON_MARKETPLACES[id]) throw new Error(`unknown Amazon marketplace: ${m} (use in | ae | sa)`);
  return id;
}

/**
 * Seller Central consent URL for the one-time authorization.
 * `version=beta` is required while the SP-API app is in draft; harmless to drop after
 * the app is published.
 */
export function buildConsentUrl({ marketplace, applicationId, state, beta = true }) {
  if (!applicationId) throw new Error('buildConsentUrl requires applicationId (AMAZON_APP_ID)');
  if (!state) throw new Error('buildConsentUrl requires a signed state');
  const mk = AMAZON_MARKETPLACES[normalizeMarketplace(marketplace)];
  const qs = new URLSearchParams({ application_id: applicationId, state });
  if (beta) qs.set('version', 'beta');
  return `${mk.sellerCentral}/apps/authorize/consent?${qs}`;
}

async function lwaPost(params, httpFetch) {
  const res = await httpFetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    throw new Error(`Amazon LWA ${params.grant_type} failed (${res.status}): ${body.error_description || body.error || 'unknown'}`);
  }
  return body;
}

/** Exchange the one-time consent code for the long-lived refresh token. */
export async function exchangeAuthCode({ code, clientId, clientSecret, redirectUri, httpFetch = fetch }) {
  if (!code) throw new Error('exchangeAuthCode requires the spapi_oauth_code');
  const body = await lwaPost({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  }, httpFetch);
  return { refreshToken: body.refresh_token, accessToken: body.access_token };
}

/**
 * Access-token minting with per-refresh-token cache. Cache keys on the token value
 * itself so a re-connect (new refresh token) never serves the old grant's access token.
 */
export function makeAccessTokenSource({ clientId, clientSecret, httpFetch = fetch, now = Date.now }) {
  const cache = new Map(); // refreshToken → { token, expiresAt }

  return async function accessTokenFor(refreshToken) {
    if (!refreshToken) throw new Error('no Amazon refresh token, connect the marketplace first');
    const hit = cache.get(refreshToken);
    if (hit && hit.expiresAt > now()) return hit.token;
    const body = await lwaPost({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }, httpFetch);
    const ttlMs = Math.max(60, (body.expires_in || 3600) - 300) * 1000; // renew 5 min early
    cache.set(refreshToken, { token: body.access_token, expiresAt: now() + ttlMs });
    return body.access_token;
  };
}
