// HAR (HTTP Archive) → capture entries.
//
// Two capture paths feed the same analyzer: the browser extension (live recording) and
// a DevTools "Save all as HAR" export. Supporting HAR matters because every portal
// operator already knows how to produce one, and because the HARs already sitting in
// this repo (Unicommerce, return flow) become replayable test fixtures.

function headerArrayToObject(list = []) {
  const out = {};
  for (const h of list) {
    if (!h?.name) continue;
    const name = String(h.name).toLowerCase();
    // HTTP/2 pseudo-headers (:authority, :method…) are framing, not request headers,
    // and would otherwise pollute the "custom header" signal in auth detection.
    if (name.startsWith(':')) continue;
    // Repeated headers (set-cookie) collapse into an array, not a lost value.
    if (out[name] === undefined) out[name] = h.value ?? '';
    else if (Array.isArray(out[name])) out[name].push(h.value ?? '');
    else out[name] = [out[name], h.value ?? ''];
  }
  return out;
}

/**
 * HAR keeps cookies in dedicated arrays as well as in headers, and Chrome's
 * "Save as HAR (sanitized)" strips the headers but can leave the arrays — so a capture
 * with no Cookie header is not necessarily a capture with no session. Fold the arrays
 * back into header form so one code path downstream sees everything.
 */
function foldCookies(headers, cookieList, headerName) {
  const list = Array.isArray(cookieList) ? cookieList.filter((c) => c?.name) : [];
  if (!list.length || headers[headerName] !== undefined) return headers;
  if (headerName === 'cookie') {
    headers.cookie = list.map((c) => `${c.name}=${c.value ?? ''}`).join('; ');
  } else {
    headers['set-cookie'] = list.map((c) => `${c.name}=${c.value ?? ''}`);
  }
  return headers;
}

/**
 * @param {object|string} har parsed HAR object or JSON text
 * @returns {Array<object>} capture entries
 */
export function harToEntries(har) {
  const doc = typeof har === 'string' ? JSON.parse(har) : har;
  const entries = doc?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('not a HAR: log.entries missing');

  return entries.map((e) => ({
    method: e?.request?.method || 'GET',
    url: e?.request?.url || '',
    status: e?.response?.status ?? null,
    startedAt: e?.startedDateTime || null,
    durationMs: typeof e?.time === 'number' ? Math.round(e.time) : null,
    resourceType: e?._resourceType || null,
    requestHeaders: foldCookies(headerArrayToObject(e?.request?.headers), e?.request?.cookies, 'cookie'),
    responseHeaders: foldCookies(headerArrayToObject(e?.response?.headers), e?.response?.cookies, 'set-cookie'),
    requestBody: e?.request?.postData?.text ?? null,
    // HAR bodies can be base64 (binary). Those carry no shape worth analyzing.
    responseBody: e?.response?.content?.encoding === 'base64'
      ? null
      : (e?.response?.content?.text ?? null),
  }));
}
