// Token-bucket rate limiter. Every UC call (public + internal, across ALL automations)
// passes through one shared limiter so we never exceed Unicommerce's throttle in
// production. `rps` is the steady sustained rate; `burst` is how many calls may fire
// back-to-back before pacing kicks in.
//
// `now` is injectable for deterministic tests; real waiting uses setTimeout.
export class RateLimiter {
  constructor({ rps = 5, burst = 10, now = () => Date.now() } = {}) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillPerMs = Math.max(0.0001, rps / 1000);
    this.now = now;
    this.last = now();
    this._queue = [];
    this._draining = false;
  }

  _refill() {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
      this.last = t;
    }
  }

  /** Synchronous, non-blocking: consume a token if one is available. */
  tryTake() {
    this._refill();
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }

  /** Await a token; resolves as soon as capacity allows, preserving FIFO order. */
  take() {
    return new Promise((resolve) => {
      this._queue.push(resolve);
      this._drain();
    });
  }

  _drain() {
    if (this._draining) return;
    this._draining = true;
    const step = () => {
      while (this._queue.length && this.tryTake()) this._queue.shift()();
      if (!this._queue.length) { this._draining = false; return; }
      this._refill();
      const waitMs = Math.max(5, Math.ceil((1 - this.tokens) / this.refillPerMs));
      setTimeout(step, waitMs);
    };
    step();
  }
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date) → milliseconds, capped. */
export function retryAfterMs(headerValue, capMs = 60_000) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.min(capMs, Math.max(0, secs * 1000));
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) return Math.min(capMs, Math.max(0, when - Date.now()));
  return null;
}
