// Capture redaction. A capture is, by design, a recording of an authenticated session:
// it CONTAINS the credentials. So the rule is not "never store secrets" — it is
//
//   the session material is extracted once, sealed into the vault, and everything that
//   remains (the part humans and models read) carries no live credential.
//
// Header names are matched case-insensitively; values are additionally scanned, because
// a portal will happily return a token inside a JSON body under a bland key.

const SECRET_HEADERS = new Set([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
  'x-amz-security-token', 'x-amz-access-token',
]);

// Header names worth KEEPING (they shape the client) even though they look auth-ish.
const STRUCTURAL_HEADERS = new Set([
  'content-type', 'accept', 'accept-language', 'referer', 'origin',
  'x-requested-with', 'user-agent',
]);

const SECRET_VALUE_PATTERNS = [
  /JSESSIONID\s*=\s*[A-Za-z0-9._-]+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g,          // JWT
  /\bAtzr?\|[A-Za-z0-9._~+/-]{20,}/g,   // Amazon LWA tokens
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,        // Google refresh token
];

const SECRET_JSON_KEY_RE = /password|passwd|secret|token|credential|api[-_]?key|session|cookie|authorization|otp/i;

export function redactString(s) {
  let out = String(s ?? '');
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Keep the header MAP shape (names matter for RE) while dropping secret values. */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = String(k).toLowerCase();
    if (SECRET_HEADERS.has(name)) {
      out[name] = '[redacted]';
    } else if (STRUCTURAL_HEADERS.has(name) || !/token|auth|key|secret/i.test(name)) {
      out[name] = redactString(v);
    } else {
      out[name] = '[redacted]';
    }
  }
  return out;
}

/**
 * Redact a request/response body. JSON is walked key-wise so the SHAPE survives —
 * shape is the entire point of a capture — while secret-ish leaves are replaced.
 * Non-JSON is pattern-scrubbed and truncated.
 */
export function redactBody(body, { maxChars = 20000 } = {}) {
  if (body == null) return null;
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return redactString(raw).slice(0, maxChars); }

  const seen = new WeakSet();
  const walk = (v) => {
    if (v == null || typeof v !== 'object') {
      return typeof v === 'string' ? redactString(v) : v;
    }
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 50).map(walk);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_JSON_KEY_RE.test(k) ? '[redacted]' : walk(val);
    }
    return out;
  };
  const cleaned = walk(parsed);
  const s = JSON.stringify(cleaned);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : cleaned;
}

/** Extract session material (to be sealed into the vault) BEFORE redaction. */
export function extractSessionMaterial(entries = []) {
  const cookies = new Map(); // name → value (last wins: freshest)
  const bearers = new Set();
  for (const e of entries) {
    const req = e?.requestHeaders || {};
    for (const [k, v] of Object.entries(req)) {
      const name = String(k).toLowerCase();
      if (name === 'cookie') {
        for (const pair of String(v).split(';')) {
          const idx = pair.indexOf('=');
          if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
        }
      }
      if (name === 'authorization' && /^bearer\s+/i.test(String(v))) {
        bearers.add(String(v).replace(/^bearer\s+/i, '').trim());
      }
    }
    const res = e?.responseHeaders || {};
    for (const [k, v] of Object.entries(res)) {
      if (String(k).toLowerCase() !== 'set-cookie') continue;
      for (const raw of [].concat(v)) {
        const first = String(raw).split(';')[0];
        const idx = first.indexOf('=');
        if (idx > 0) cookies.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
      }
    }
  }
  return {
    cookies: Object.fromEntries(cookies),
    cookieHeader: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    bearers: [...bearers],
  };
}

/** Full-entry redaction — what gets persisted and shown. */
export function redactEntry(entry = {}) {
  return {
    method: String(entry.method || 'GET').toUpperCase(),
    url: redactUrl(entry.url),
    status: entry.status ?? null,
    startedAt: entry.startedAt ?? null,
    durationMs: entry.durationMs ?? null,
    resourceType: entry.resourceType || null,
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
    requestBody: redactBody(entry.requestBody),
    responseBody: redactBody(entry.responseBody),
  };
}

/** Query strings carry tokens too (?auth=…&sid=…). Keep key names, drop secret values. */
export function redactUrl(url) {
  const raw = String(url || '');
  let u;
  try { u = new URL(raw); } catch { return redactString(raw); }
  for (const [k, v] of [...u.searchParams]) {
    if (SECRET_JSON_KEY_RE.test(k)) u.searchParams.set(k, '[redacted]');
    else u.searchParams.set(k, redactString(v));
  }
  return u.toString();
}
