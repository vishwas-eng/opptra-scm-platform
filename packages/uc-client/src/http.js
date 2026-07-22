// Low-level HTTP with timeouts and *conservative* retries.
//
// Retry policy: GETs and explicitly-marked-idempotent calls retry on network errors
// and 502/503/504. POSTs do NOT retry by default — UC mutations (allocate, invoice,
// dispatch) are not idempotent and a blind retry can double-execute. Callers that
// know a call is safe pass { idempotent: true }.
import { logger } from '@opptra/core/logger';

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never log full URLs: the OAuth token endpoint carries credentials in its query
// string, and other UC URLs can carry business identifiers. Log host+path only.
function safeUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return '[unparseable-url]'; }
}

export function makeHttp({ fetchImpl = fetch } = {}) {
  async function request(url, opts = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      idempotent = method === 'GET',
      maxRetries = 2,
      redirect = 'manual',
    } = opts;

    let attempt = 0;
    // First attempt + up to maxRetries retries when allowed.
    for (;;) {
      attempt += 1;
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body,
          redirect,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network-level failure. The request may or may not have reached the server,
        // so only retry when the caller declared the call idempotent.
        if (idempotent && attempt <= maxRetries) {
          const delay = 500 * attempt + Math.floor(Math.random() * 250);
          logger.warn({ url: safeUrl(url), attempt, err: String(err) }, 'uc http network error, retrying');
          await sleep(delay);
          continue;
        }
        throw err;
      }
      if (idempotent && RETRYABLE_STATUS.has(res.status) && attempt <= maxRetries) {
        const delay = 750 * attempt + Math.floor(Math.random() * 250);
        logger.warn({ url: safeUrl(url), status: res.status, attempt }, 'uc http retryable status, retrying');
        await sleep(delay);
        continue;
      }
      return res;
    }
  }

  return { request };
}

/** Simple async mutex — serializes facility-scoped internal calls. */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const next = this.#tail.then(fn, fn);
    // Keep the chain alive even if fn rejects.
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
