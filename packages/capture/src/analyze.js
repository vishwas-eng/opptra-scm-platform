// Capture analysis — turn a recorded browsing session into a connector blueprint.
//
// This is the step that used to be a human reading a 100 MB HAR for an afternoon. It
// answers the four questions every new connector needs:
//   1. which host is the API (vs the CDN, analytics, fonts…),
//   2. how the session is carried (cookie name? bearer? CSRF/tenant header?),
//   3. which endpoints exist, in path-template form, with their payload shapes,
//   4. which of those look like orders / inventory / shipments — i.e. what to register.
//
// Everything here is pure: entries in, blueprint out. No network, no DB.

const ASSET_EXT_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|map)(\?|$)/i;
// Static JSON is the trap: an SPA ships translations, feature flags and PWA manifests
// as .json with content-type: application/json, so a content-type test alone files them
// as APIs and they crowd out the real endpoints in the ranking.
const STATIC_PATH_RE = /(^|\/)(assets|static|i18n|locales?|fonts?|images?|img|media|build|_next|dist)(\/|$)|(^|\/)(manifest|asset-manifest|version|resource)\.json$/i;
const ANALYTICS_HOST_RE = /(google-analytics|googletagmanager|doubleclick|facebook|hotjar|segment|sentry|newrelic|datadog|clarity\.ms|mixpanel|amplitude|optimizely|braze|cloudflareinsights)/i;

/** Path segments that are obviously values, not route names. */
function templatizeSegment(seg) {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
  if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}';
  if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return '{date}';
  // Mixed alphanumeric with digits and length > 8 is nearly always an identifier
  // (order numbers, SKUs in a path). Keep short words — those are route names.
  if (seg.length > 8 && /\d/.test(seg) && /[a-z]/i.test(seg)) return '{code}';
  return seg;
}

export function templatizePath(pathname) {
  return String(pathname || '/')
    .split('/')
    .map(templatizeSegment)
    .join('/');
}

/**
 * Describe a JSON value as a compact type tree — the shape, never the data.
 *
 * Arrays become `{ array: <element shape> }` rather than a string like `array<…>`:
 * an element shape is usually an object, and interpolating it into a string collapses
 * the whole row schema to "[object Object]" — which is exactly the part of the capture
 * a connector author needs.
 */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return { array: 'empty' };
    if (depth >= 4) return { array: '…' };
    return { array: shapeOf(value[0], depth + 1) };
  }
  const t = typeof value;
  if (t !== 'object') return t;
  if (depth >= 4) return 'object<…>';
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = shapeOf(v, depth + 1);
  return out;
}

function parseMaybeJson(body) {
  if (body == null) return null;
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch { return null; }
}

/** Keyword → capability mapping, so the blueprint suggests real action ids. */
const CAPABILITY_HINTS = [
  { re: /order|sale|purchase/i, action: 'orders.search' },
  { re: /invent|stock|quantity|listing/i, action: 'inventory.get' },
  { re: /shipment|ship|dispatch|awb|manifest|package/i, action: 'shipments.search' },
  { re: /invoice|billing|payment|settle|remit/i, action: 'invoices.get' },
  { re: /return|rto|refund|cancel/i, action: 'returns.search' },
  { re: /catalog|product|sku|item/i, action: 'catalog.search' },
  { re: /label|pick|pack/i, action: 'labels.get' },
];

function suggestCapability(pathname) {
  for (const { re, action } of CAPABILITY_HINTS) {
    if (re.test(pathname)) return action;
  }
  return null;
}

function isApiLike(entry, url) {
  if (ASSET_EXT_RE.test(url.pathname)) return false;
  if (STATIC_PATH_RE.test(url.pathname)) return false;
  if (ANALYTICS_HOST_RE.test(url.hostname)) return false;
  const type = String(entry.resourceType || '').toLowerCase();
  if (['image', 'stylesheet', 'font', 'media', 'script'].includes(type)) return false;
  const ct = String(
    entry.responseHeaders?.['content-type'] || entry.responseHeaders?.['Content-Type'] || '',
  ).toLowerCase();
  if (ct.includes('json') || ct.includes('xml')) return true;
  if (type === 'xmlhttprequest' || type === 'fetch') return true;
  // A POST that isn't an asset is interesting even without a content-type.
  return String(entry.method || 'GET').toUpperCase() !== 'GET' && !ct.includes('html');
}

/** Auth signals: how does this portal carry the session? */
export function detectAuth(entries = []) {
  const cookieNames = new Map(); // name → count
  const headerNames = new Map();
  let bearer = false;
  let loginPost = null;

  for (const e of entries) {
    const req = e.requestHeaders || {};
    for (const [k, v] of Object.entries(req)) {
      const name = String(k).toLowerCase();
      if (name === 'cookie') {
        for (const pair of String(v).split(';')) {
          const n = pair.split('=')[0].trim();
          if (n) cookieNames.set(n, (cookieNames.get(n) || 0) + 1);
        }
      } else if (name === 'authorization') {
        if (/^bearer/i.test(String(v))) bearer = true;
      } else if (/^x-|csrf|xsrf|tenant|client-id|store|seller/i.test(name)) {
        headerNames.set(name, (headerNames.get(name) || 0) + 1);
      }
    }
    if (!loginPost && String(e.method).toUpperCase() === 'POST' && /login|signin|auth|session|token/i.test(e.url || '')) {
      let u; try { u = new URL(e.url); } catch { u = null; }
      if (u) loginPost = { method: 'POST', host: u.hostname, path: u.pathname, status: e.status ?? null };
    }
  }

  const byCount = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  const cookies = byCount(cookieNames);
  return {
    // The cookie present on the most requests is the session cookie in every portal
    // we have cracked so far (JSESSIONID on UC, the Vinculum one on Home Centre).
    sessionCookie: cookies[0]?.name || null,
    cookies,
    bearer,
    customHeaders: byCount(headerNames),
    loginRequest: loginPost,
    // Chrome's "Save all as HAR (sanitized)" strips Cookie/Set-Cookie entirely, so a
    // capture can be perfect for endpoint discovery yet carry no session at all. Say so
    // loudly — otherwise the connector gets built and then fails to authenticate.
    warning: (!cookies.length && !bearer)
      ? 'No cookie or bearer captured — this looks like a sanitized HAR export. Endpoint discovery is still valid, but use the Opptra Capture extension (or an unsanitized export) to obtain a usable session.'
      : null,
  };
}

/**
 * Full analysis.
 * @param {Array<object>} entries redacted or raw capture entries
 * @param {{ maxEndpoints?: number }} [opts]
 */
export function analyzeCapture(entries = [], { maxEndpoints = 120 } = {}) {
  const hosts = new Map();
  const endpoints = new Map(); // `${method} ${host}${templatePath}` → record
  let skipped = 0;

  for (const entry of entries) {
    let url;
    try { url = new URL(entry.url); } catch { skipped += 1; continue; }

    const host = url.hostname;
    if (!hosts.has(host)) hosts.set(host, { host, total: 0, api: 0 });
    const hostRec = hosts.get(host);
    hostRec.total += 1;

    if (!isApiLike(entry, url)) continue;
    hostRec.api += 1;

    const template = templatizePath(url.pathname);
    const method = String(entry.method || 'GET').toUpperCase();
    const key = `${method} ${host}${template}`;

    if (!endpoints.has(key)) {
      endpoints.set(key, {
        method,
        host,
        path: template,
        calls: 0,
        statuses: {},
        queryKeys: new Set(),
        requestShape: null,
        responseShape: null,
        suggestedAction: suggestCapability(url.pathname),
      });
    }
    const rec = endpoints.get(key);
    rec.calls += 1;
    const st = entry.status ?? 0;
    rec.statuses[st] = (rec.statuses[st] || 0) + 1;
    for (const k of url.searchParams.keys()) rec.queryKeys.add(k);

    if (!rec.requestShape) {
      const body = parseMaybeJson(entry.requestBody);
      if (body) rec.requestShape = shapeOf(body);
    }
    if (!rec.responseShape) {
      const body = parseMaybeJson(entry.responseBody);
      if (body) rec.responseShape = shapeOf(body);
    }
  }

  const endpointList = [...endpoints.values()]
    .map((e) => ({ ...e, queryKeys: [...e.queryKeys].sort() }))
    .sort((a, b) => b.calls - a.calls);

  const hostList = [...hosts.values()].sort((a, b) => b.api - a.api || b.total - a.total);
  const primaryHost = hostList.find((h) => h.api > 0)?.host || hostList[0]?.host || null;

  return {
    summary: {
      entries: entries.length,
      unparseableUrls: skipped,
      apiCalls: endpointList.reduce((s, e) => s + e.calls, 0),
      hosts: hostList.length,
      endpoints: endpointList.length,
      primaryHost,
    },
    hosts: hostList,
    auth: detectAuth(entries),
    endpoints: endpointList.slice(0, maxEndpoints),
    truncatedEndpoints: Math.max(0, endpointList.length - maxEndpoints),
    // Endpoints that map to a capability we know how to register — the shortlist a
    // human (or the agent) reviews first.
    suggestedActions: endpointList
      .filter((e) => e.suggestedAction)
      .slice(0, 40)
      .map((e) => ({ action: e.suggestedAction, method: e.method, host: e.host, path: e.path, calls: e.calls })),
  };
}
