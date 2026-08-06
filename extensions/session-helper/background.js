/* Opptra Connector Capture — background recorder.
 *
 * You log into the seller portal normally. This worker records the request/response
 * metadata for the portal's own hosts, batches it, and posts it to the platform, which
 * seals the session and derives the connector blueprint.
 *
 * Deliberate limits of MV3, and why they are acceptable:
 *  - webRequest in MV3 is OBSERVE-only, so response BODIES are not available here. The
 *    platform gets URLs, methods, statuses, headers and request bodies — enough for
 *    endpoint discovery and auth detection. When response shapes matter, upload a
 *    DevTools HAR (same pipeline, /api/capture/har).
 *  - Cookie headers are stripped from webRequest by Chrome unless extraHeaders is
 *    requested, so the session is read separately via chrome.cookies (authoritative,
 *    includes HttpOnly) and attached to the first batch.
 */

const BATCH_MS = 2500;
const MAX_BATCH = 100;

const state = {
  recording: false,
  captureUid: null,
  connectorId: null,
  platform: '',
  token: '',
  hosts: [],          // hostname suffixes we record
  tabId: null,
  buffer: [],
  seen: 0,
  sent: 0,
  dropped: 0,
  lastError: '',
  cookiesAttached: false,
};

const pending = new Map(); // requestId → partial entry

function hostMatches(url) {
  if (!state.hosts.length) return false;
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  return state.hosts.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function headerArrayToObject(list = []) {
  const out = {};
  for (const h of list) {
    if (!h?.name) continue;
    const name = h.name.toLowerCase();
    if (out[name] === undefined) out[name] = h.value ?? '';
    else if (Array.isArray(out[name])) out[name].push(h.value ?? '');
    else out[name] = [out[name], h.value ?? ''];
  }
  return out;
}

/** Chrome gives request bodies as raw bytes or form fields; normalize to a string. */
function decodeRequestBody(requestBody) {
  if (!requestBody) return null;
  if (requestBody.formData) return JSON.stringify(requestBody.formData);
  const raw = requestBody.raw?.[0]?.bytes;
  if (!raw) return null;
  try { return new TextDecoder('utf-8').decode(new Uint8Array(raw)); } catch { return null; }
}

function onBeforeRequest(details) {
  if (!state.recording || !hostMatches(details.url)) return;
  pending.set(details.requestId, {
    method: details.method,
    url: details.url,
    resourceType: details.type,
    startedAt: new Date(details.timeStamp).toISOString(),
    requestBody: decodeRequestBody(details.requestBody),
    requestHeaders: {},
    responseHeaders: {},
    status: null,
    responseBody: null, // MV3 cannot observe bodies; HAR upload covers that case
  });
}

function onSendHeaders(details) {
  const entry = pending.get(details.requestId);
  if (entry) entry.requestHeaders = headerArrayToObject(details.requestHeaders);
}

function finish(details) {
  const entry = pending.get(details.requestId);
  if (!entry) return;
  pending.delete(details.requestId);
  entry.status = details.statusCode ?? null;
  if (details.responseHeaders) entry.responseHeaders = headerArrayToObject(details.responseHeaders);
  entry.durationMs = Math.max(0, Math.round(details.timeStamp - Date.parse(entry.startedAt)));

  state.seen += 1;
  if (state.buffer.length >= MAX_BATCH * 4) {
    state.dropped += 1; // platform is not keeping up; never grow unbounded in a worker
    return;
  }
  state.buffer.push(entry);
}

const FILTER = { urls: ['<all_urls>'] };

function attachListeners() {
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, FILTER, ['requestHeaders']);
  chrome.webRequest.onCompleted.addListener(finish, FILTER, ['responseHeaders']);
  chrome.webRequest.onErrorOccurred.addListener(finish, FILTER);
}

function detachListeners() {
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
  chrome.webRequest.onCompleted.removeListener(finish);
  chrome.webRequest.onErrorOccurred.removeListener(finish);
}

async function api(path, body) {
  const res = await fetch(`${state.platform}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * The session lives in cookies the page never sends to webRequest observers (HttpOnly).
 * Read them from the cookie store for each recorded host and ship them as one synthetic
 * entry, which is exactly the shape extractSessionMaterial() already understands.
 */
async function collectCookieEntry() {
  const jar = [];
  for (const host of state.hosts) {
    const cookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
    for (const c of cookies) jar.push(`${c.name}=${c.value}`);
  }
  if (!jar.length) return null;
  return {
    method: 'GET',
    url: `https://${state.hosts[0]}/__opptra_session_probe`,
    status: 200,
    resourceType: 'other',
    requestHeaders: { cookie: jar.join('; ') },
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
  };
}

async function flush() {
  if (!state.recording || !state.captureUid) return;
  const batch = state.buffer.splice(0, MAX_BATCH);
  if (!state.cookiesAttached) {
    const cookieEntry = await collectCookieEntry();
    if (cookieEntry) {
      batch.unshift(cookieEntry);
      state.cookiesAttached = true;
    }
  }
  if (!batch.length) return;
  try {
    const r = await api(`/api/capture/sessions/${state.captureUid}/entries`, { entries: batch });
    state.sent += r.accepted || 0;
    state.dropped += r.dropped || 0;
    state.lastError = '';
  } catch (err) {
    state.lastError = String(err.message || err);
    // Put the batch back so a transient platform hiccup does not lose the login flow.
    state.buffer.unshift(...batch);
  }
}

setInterval(() => { flush().catch(() => {}); }, BATCH_MS);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'status') {
      sendResponse({
        recording: state.recording,
        connectorId: state.connectorId,
        captureUid: state.captureUid,
        seen: state.seen,
        sent: state.sent,
        dropped: state.dropped,
        lastError: state.lastError,
      });
      return;
    }

    if (msg.type === 'start') {
      Object.assign(state, {
        platform: msg.platform.replace(/\/+$/, ''),
        token: msg.token,
        connectorId: msg.connectorId,
        hosts: msg.hosts,
        buffer: [], seen: 0, sent: 0, dropped: 0, lastError: '', cookiesAttached: false,
      });
      try {
        const r = await api('/api/capture/sessions', { connectorId: msg.connectorId, label: msg.label || '' });
        state.captureUid = r.capture.capture_uid;
        state.recording = true;
        attachListeners();
        if (msg.openUrl) await chrome.tabs.create({ url: msg.openUrl });
        sendResponse({ ok: true, captureUid: state.captureUid });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return;
    }

    if (msg.type === 'stop') {
      state.recording = false;
      detachListeners();
      // Drain whatever is left before asking the platform to analyze it.
      for (let i = 0; i < 10 && state.buffer.length; i += 1) {
        state.recording = true; await flush(); state.recording = false;
      }
      try {
        const r = await api(`/api/capture/sessions/${state.captureUid}/finish`, {});
        const uid = state.captureUid;
        state.captureUid = null;
        sendResponse({ ok: true, capture: r.capture, captureUid: uid });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    }
  })();
  return true; // async sendResponse
});
