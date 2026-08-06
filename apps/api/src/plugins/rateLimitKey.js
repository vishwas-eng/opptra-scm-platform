// Per-user rate-limit bucketing.
//
// @fastify/rate-limit runs on the onRequest hook — BEFORE preValidation auth — so the
// signed-in identity is not available yet and we have to read the cookie ourselves. The
// JWT signature is NOT verified here (verifying twice per request would be wasteful, and
// this is only a bucketing key, not an authorization decision), so the email in the
// payload is attacker-controlled: anyone can mint `{"email":"<random>"}` and claim a
// fresh bucket. Binding every bucket to the source IP as well means a forged email can
// only ever split that one IP's traffic, never escape it.
//
// Requests that reach a handler have still passed real JWT verification in the auth
// plugin — this file decides *which counter to increment*, never *who you are*.
function claimedEmail(req) {
  try {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)opptra_session=([^;]+)/);
    if (!m) return '';
    const payload = decodeURIComponent(m[1]).split('.')[1];
    if (!payload) return '';
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const email = String(claims.email || '').toLowerCase();
    // Cap length so an oversized forged claim cannot bloat the limiter's key store.
    return email.slice(0, 120);
  } catch {
    return '';
  }
}

export function userBucket(req) {
  const email = claimedEmail(req);
  return email ? `${req.ip}|u:${email}` : `${req.ip}|anon`;
}

/** Route config helper: `config: perUser(30, '1 minute')`. */
export const perUser = (max, timeWindow) => ({
  rateLimit: { max, timeWindow, keyGenerator: userBucket },
});
