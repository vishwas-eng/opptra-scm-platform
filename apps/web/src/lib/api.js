// Platform API client.
//
// Auth is the httpOnly `opptra_session` cookie — there is no token to attach and
// nothing to read; every call just needs credentials:'same-origin'. A 401 means the
// session died, which is a global event (log the user out), not a per-call failure.

let onUnauthorized = () => {};

/** Called once at boot so a 401 anywhere can drop the app back to the login view. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === 'function' ? fn : () => {};
}

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Build the human message for a failed response. The API returns `error` plus, for
 * validation failures, `fieldErrors[]` — surfacing the first field error is what turns
 * "invalid input" into something the operator can act on.
 */
function messageFor(data, status) {
  const base = data?.error || `Request failed (${status})`;
  const fields = Array.isArray(data?.fieldErrors) ? data.fieldErrors : [];
  if (!fields.length) return base;
  const first = fields[0]?.message;
  if (fields.length === 1 && first && !base.includes(first)) return `${base} — ${first}`;
  if (fields.length > 1) return `${base} (${fields.length} issues)`;
  return base;
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, signal?: AbortSignal, raw?: boolean }} [opts]
 *   raw:true returns the Response untouched (for endpoints whose non-2xx body matters
 *   and for multipart uploads).
 */
export async function api(path, opts = {}) {
  const init = {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    signal: opts.signal,
  };
  if (opts.body instanceof FormData) {
    init.body = opts.body; // let the browser set the multipart boundary
  } else if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, init);
  if (opts.raw) return res;

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError('signed out', { status: 401 });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }

  if (!res.ok) throw new ApiError(messageFor(data, res.status), { status: res.status, body: data });
  return data;
}

/* ------------------------------- runs ------------------------------- */

const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 10 * 60_000;

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed']);

/**
 * Poll one run to completion.
 *
 * `onProgress` fires on every intermediate poll so the UI can show real state —
 * `pending_retry` in particular must be visible, or a run that is quietly retrying
 * looks identical to one that has hung.
 *
 * @returns {Promise<object>} the finished run row
 */
export async function pollRun(runUid, { onProgress, signal, timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new ApiError('cancelled', { status: 0 });
    const run = await api(`/api/runs/${encodeURIComponent(runUid)}`, { signal });
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    onProgress?.(run);
    if (Date.now() - started > timeoutMs) {
      throw new ApiError('This is taking longer than expected. Check Recent Activity for the result.', { status: 0, body: run });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Submit an automation and wait for its result.
 *
 * Routes answer in one of two shapes: `{ runUid }` for queued work, or the finished
 * payload itself for anything the API can do synchronously. Both are normalized to a
 * run-shaped object so callers never branch on it.
 */
export async function runJob(path, body, { onProgress, signal } = {}) {
  const submitted = await api(path, { body, signal });
  if (!submitted?.runUid) {
    return { status: 'succeeded', result: submitted, synchronous: true };
  }
  return pollRun(submitted.runUid, { onProgress, signal });
}

/* ------------------------------- SSE ------------------------------- */

/**
 * POST a body and consume a Server-Sent Events response.
 *
 * EventSource cannot POST or send a body, so this parses the stream by hand. The SSE
 * frame format is `event: <name>\ndata: <json>\n\n`; frames are split on the blank
 * line, and a partial frame at the end of a chunk stays in the buffer until the rest
 * arrives — dropping it would silently lose the last tool result of a turn.
 *
 * @param {string} path
 * @param {object} body
 * @param {{ onEvent: (name: string, data: any) => void, signal?: AbortSignal }} opts
 */
export async function streamPost(path, body, { onEvent, signal } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError('signed out', { status: 401 });
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    throw new ApiError(messageFor(data, res.status), { status: res.status, body: data });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let payload = null;
      try { payload = JSON.parse(dataLines.join('\n')); } catch { payload = { raw: dataLines.join('\n') }; }
      onEvent?.(name, payload);
    }
  }
}
