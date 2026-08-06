// PortalGuard — the safety governor every reverse-engineered connector calls through.
//
// Official APIs publish their limits and expect automation. Seller portals publish
// nothing and are watched by anti-bot systems, so the risk is not "a request fails" —
// it is "the account gets flagged". This module makes our traffic look like a careful
// human operator and, crucially, makes it STOP on the first sign of trouble instead of
// hammering into a block.
//
// Six rules, in the order they matter:
//   1. Serial per portal. One session, one in-flight request. Parallel fan-out from a
//      single cookie is the loudest possible bot signal.
//   2. Paced with jitter. A fixed interval is itself a fingerprint; real clicking is
//      irregular, so the delay is randomized within a band.
//   3. Obey the server. 429/503 with Retry-After waits exactly that long — arguing with
//      an explicit backoff instruction is how soft limits become hard bans.
//   4. Back off exponentially on repeated failure, with jitter to avoid lock-step retry.
//   5. Trip a circuit breaker on block signals (403, CAPTCHA, login redirect). Once
//      open, we make NO further calls until a human looks — the single most important
//      rule, because retrying into a block is what converts it to a ban.
//   6. Spend a daily budget. A runaway loop can otherwise issue 100k requests overnight.
//
// Defaults are deliberately timid. A connector that needs more must say so explicitly.

import { CONNECTOR_ERROR_CODES, connectorError } from './errors.js';

export const DEFAULT_POLICY = Object.freeze({
  minDelayMs: 900,        // floor between two requests to one portal
  jitterMs: 700,          // random extra, so the cadence is never metronomic
  maxConcurrent: 1,       // serial per portal — never parallelize one session
  maxRetries: 2,          // per call, on transient failures only
  backoffBaseMs: 2000,
  backoffMaxMs: 60_000,
  maxRetryAfterMs: 300_000, // honour Retry-After up to 5 min; beyond that, give up and alert
  breakerThreshold: 3,    // consecutive block signals before the circuit opens
  dailyBudget: 5000,      // requests per portal per rolling 24h
});

/** Signals that mean "the portal is pushing back", as opposed to an ordinary error. */
export const BLOCK_SIGNALS = Object.freeze({
  FORBIDDEN: 'FORBIDDEN',           // 403
  CAPTCHA: 'CAPTCHA',               // challenge page in the body
  LOGIN_REDIRECT: 'LOGIN_REDIRECT', // bounced to the login screen mid-session
  RATE_LIMITED: 'RATE_LIMITED',     // 429
});

const CAPTCHA_MARKERS = [
  'captcha', 'are you a robot', 'unusual traffic', 'access denied',
  'cf-challenge', 'cf-browser-verification', 'px-captcha', 'perimeterx',
  'incapsula', 'distil', 'bot detection', 'verify you are human',
];

/**
 * Classify a response. Returns a BLOCK_SIGNAL or null.
 * `body` is a short prefix of the response text — never the whole payload.
 */
export function detectBlock({ status, headers = {}, body = '', finalUrl = '', requestUrl = '' } = {}) {
  if (status === 429) return BLOCK_SIGNALS.RATE_LIMITED;
  if (status === 403) return BLOCK_SIGNALS.FORBIDDEN;

  const text = String(body || '').slice(0, 4000).toLowerCase();
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  // Only sniff HTML/text: a JSON payload legitimately containing the word "captcha"
  // (a field name, a product title) must not trip the breaker.
  if (contentType.includes('html') || contentType.includes('text/plain')) {
    if (CAPTCHA_MARKERS.some((m) => text.includes(m))) return BLOCK_SIGNALS.CAPTCHA;
  }

  // A data call that lands on a login page means the session died or was killed.
  if (finalUrl && requestUrl && finalUrl !== requestUrl && /login|signin|auth/i.test(finalUrl)) {
    return BLOCK_SIGNALS.LOGIN_REDIRECT;
  }
  return null;
}

/** Parse Retry-After, which is either delta-seconds or an HTTP date. */
export function retryAfterMs(headers = {}, { now = Date.now, max = DEFAULT_POLICY.maxRetryAfterMs } = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, max);
  const when = Date.parse(s);
  if (Number.isNaN(when)) return null;
  return Math.min(Math.max(0, when - now()), max);
}

class Breaker {
  constructor(threshold) {
    this.threshold = threshold;
    this.consecutive = 0;
    this.open = false;
    this.reason = null;
    this.openedAt = null;
  }

  recordBlock(signal, now) {
    this.consecutive += 1;
    if (this.consecutive >= this.threshold) {
      this.open = true;
      this.reason = signal;
      this.openedAt = now;
    }
  }

  recordSuccess() {
    this.consecutive = 0;
  }

  /** Only a human clears the breaker — an automatic half-open retry is how a soft
   *  block becomes a permanent one. */
  reset() {
    this.consecutive = 0;
    this.open = false;
    this.reason = null;
    this.openedAt = null;
  }
}

/**
 * Create a guard for ONE portal (one connector, one session).
 *
 * @param {{
 *   portal: string,
 *   policy?: Partial<typeof DEFAULT_POLICY>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   onAlert?: (info: object) => void,
 * }} opts
 */
export function createPortalGuard({
  portal,
  policy = {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  onAlert,
} = {}) {
  if (!portal) throw new Error('createPortalGuard requires a portal name');
  const p = { ...DEFAULT_POLICY, ...policy };
  const breaker = new Breaker(p.breakerThreshold);

  let lastRequestAt = 0;
  let chain = Promise.resolve(); // serializes every call through this guard
  const spend = []; // request timestamps, trimmed to a rolling 24h

  function budgetRemaining() {
    const cutoff = now() - 86_400_000;
    while (spend.length && spend[0] < cutoff) spend.shift();
    return p.dailyBudget - spend.length;
  }

  async function pace() {
    const since = now() - lastRequestAt;
    const wait = p.minDelayMs + Math.floor(random() * p.jitterMs) - since;
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  }

  function backoffFor(attempt) {
    const base = Math.min(p.backoffBaseMs * (2 ** attempt), p.backoffMaxMs);
    // Full jitter: two workers that failed together must not retry together.
    return Math.floor(base / 2 + random() * (base / 2));
  }

  /**
   * Run one guarded request.
   *
   * @param {() => Promise<{ status: number, headers?: object, body?: string, finalUrl?: string, url?: string, data?: any }>} fetchOnce
   * @param {{ label?: string }} [meta]
   * @returns {Promise<{ ok: true, response: object } | object>} connectorError on refusal
   */
  function run(fetchOnce, meta = {}) {
    const task = chain.then(async () => {
      if (breaker.open) {
        return connectorError(
          CONNECTOR_ERROR_CODES.PERMISSION_DENIED,
          `${portal} is paused: ${breaker.reason} detected. An operator must re-check the account and reset the connector before it runs again.`,
          { portal, blocked: true, signal: breaker.reason, openedAt: breaker.openedAt, retryable: false },
        );
      }
      if (budgetRemaining() <= 0) {
        return connectorError(
          CONNECTOR_ERROR_CODES.RATE_LIMITED,
          `${portal} daily request budget (${p.dailyBudget}) is exhausted. It refills on a rolling 24h window.`,
          { portal, retryable: false },
        );
      }

      for (let attempt = 0; attempt <= p.maxRetries; attempt += 1) {
        await pace();
        spend.push(now());

        let res;
        try {
          res = await fetchOnce();
        } catch (err) {
          // Transport failure (DNS, socket). Retry — this is not a block signal.
          if (attempt === p.maxRetries) {
            return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
              `${portal}: ${String(err.message || err)}`, { portal, retryable: true });
          }
          await sleep(backoffFor(attempt));
          continue;
        }

        const signal = detectBlock({
          status: res.status,
          headers: res.headers,
          body: res.body,
          finalUrl: res.finalUrl,
          requestUrl: res.url,
        });

        if (signal === BLOCK_SIGNALS.RATE_LIMITED) {
          breaker.recordBlock(signal, now());
          const wait = retryAfterMs(res.headers || {}, { now, max: p.maxRetryAfterMs }) ?? backoffFor(attempt);
          if (attempt === p.maxRetries || breaker.open) {
            onAlert?.({ portal, signal, label: meta.label, breakerOpen: breaker.open });
            return connectorError(CONNECTOR_ERROR_CODES.RATE_LIMITED,
              `${portal} is rate-limiting us. Backing off; the connector will not retry automatically.`,
              { portal, retryAfterMs: wait, blocked: breaker.open, retryable: !breaker.open });
          }
          await sleep(wait);
          continue;
        }

        if (signal) {
          // 403 / CAPTCHA / login-redirect: STOP. Do not retry — retrying into a
          // challenge is precisely what escalates a soft block into a ban.
          breaker.recordBlock(signal, now());
          onAlert?.({ portal, signal, label: meta.label, breakerOpen: breaker.open });
          return connectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED,
            `${portal} returned a ${signal} signal. Stopped without retrying to protect the account.`,
            { portal, blocked: true, signal, breakerOpen: breaker.open, retryable: false });
        }

        if (res.status >= 500) {
          if (attempt === p.maxRetries) {
            return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
              `${portal} returned ${res.status}`, { portal, status: res.status, retryable: true });
          }
          await sleep(backoffFor(attempt));
          continue;
        }

        breaker.recordSuccess();
        return { ok: true, response: res };
      }

      return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
        `${portal}: exhausted retries`, { portal, retryable: true });
    });

    // Keep the chain alive regardless of this task's outcome, or one rejection would
    // wedge every later call behind a permanently rejected promise.
    chain = task.then(() => {}, () => {});
    return task;
  }

  return {
    portal,
    policy: p,
    run,
    status() {
      return {
        portal,
        breakerOpen: breaker.open,
        blockSignal: breaker.reason,
        openedAt: breaker.openedAt,
        consecutiveBlocks: breaker.consecutive,
        budgetRemaining: budgetRemaining(),
        dailyBudget: p.dailyBudget,
      };
    },
    /** Operator action after they have checked the account is healthy. */
    reset() { breaker.reset(); },
  };
}
