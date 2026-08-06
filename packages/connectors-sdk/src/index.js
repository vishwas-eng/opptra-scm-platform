/** Shared action registry + connector shell used by marketplace packages. */

import { CONNECTOR_ERROR_CODES, connectorError } from './errors.js';

export {
  CONNECTOR_ERROR_CODES, connectorError, isRetryable,
} from './errors.js';

export function createRegistry() {
  const actions = new Map();
  return {
    register(def) {
      if (!def?.id || typeof def.handler !== 'function') throw new Error('register() requires id and handler');
      if (actions.has(def.id)) throw new Error(`duplicate action id: ${def.id}`);
      actions.set(def.id, {
        id: def.id,
        title: def.title || def.id,
        mutates: !!def.mutates,
        backend: def.backend || 're',
        description: def.description || '',
        inputSchema: def.inputSchema || { type: 'object' },
        awaitingHar: !!def.awaitingHar,
        handler: def.handler,
      });
    },
    getAction(id) { return actions.get(id) || null; },
    listRegisteredActions() {
      return [...actions.values()].map(({ handler, ...meta }) => meta);
    },
    _reset() { actions.clear(); },
  };
}

/**
 * Build a standard connector object.
 * @param {{ id, name, auth, registry, health?, beforeInvoke? }} opts
 */
export function createConnectorShell({ id, name, auth, registry, health, beforeInvoke }) {
  return {
    id,
    name,
    auth,
    listCapabilities() {
      return registry.listRegisteredActions().map((a) => ({
        id: a.id,
        title: a.title,
        mutates: a.mutates,
        backend: a.backend,
        description: a.description,
        inputSchema: a.inputSchema,
        awaitingHar: a.awaitingHar,
      }));
    },
    async health() {
      if (typeof health === 'function') return health();
      return { ok: false, connector: id, error: 'health not implemented' };
    },
    async invoke(action, params = {}, ctx = {}) {
      if (beforeInvoke) await beforeInvoke(action, params, ctx);
      const def = registry.getAction(action);
      if (!def) {
        return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `unknown action: ${action}`, { action });
      }
      if (def.awaitingHar && !ctx.allowStub) {
        return connectorError(
          CONNECTOR_ERROR_CODES.AWAITING_HAR,
          `${name}: action '${action}' needs a sanitized HAR / live session. Paste session in Connectors panel or see docs/connectors/.`,
          { action, awaitingHar: true },
        );
      }
      if (def.mutates && ctx.dryRun) {
        return { ok: true, dryRun: true, action, preview: { params } };
      }
      return def.handler(params || {}, ctx);
    },
  };
}

// Secret-shaped VALUES. Key-name redaction alone is not enough: an upstream portal can
// return a cookie inside a message string, or a raw response body we pass through, and
// the key would be something innocuous like `note` or `detail`.
const SECRET_VALUE_PATTERNS = [
  /JSESSIONID\s*=\s*[A-Za-z0-9._-]+/gi,   // UC session cookie
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // Authorization: bearer …
  /\beyJ[A-Za-z0-9._-]{20,}/g,            // JWT (id/access tokens)
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,          // Google OAuth refresh token
];

const SECRET_KEY_RE = /cookie|jsession|password|secret|token|authorization|refresh|credential|api[-_]?key/i;

function scrubString(s) {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/**
 * Make a connector/tool result safe and affordable to hand to an LLM.
 *
 * Three jobs, in order:
 *  1. redact secret-looking KEYS and secret-looking VALUES,
 *  2. cap array lengths so one huge list cannot blow the context,
 *  3. keep the whole thing under maxChars — by shrinking the biggest arrays, NOT by
 *     replacing the result with an opaque preview blob. The old behaviour threw away
 *     `ok` / `code` / `error` on any result over 4 KB, so a 50-row Waypoint answer came
 *     back as `{truncated, preview}` and every `r.ok !== false` check silently passed on
 *     a result that carried no data at all.
 *
 * Cyclic input is handled (a self-referential upstream object used to throw RangeError
 * out of the tool executor).
 */
export function sanitizeResult(obj, opts = {}) {
  const { maxChars = 12000, maxArray = 200 } = typeof opts === 'number' ? { maxChars: opts } : opts;
  const seen = new WeakSet();

  const scrub = (v) => {
    if (v == null) return v;
    if (typeof v === 'string') return scrubString(v);
    if (typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, maxArray).map(scrub);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : scrub(val);
    }
    return out;
  };

  const cleaned = scrub(obj);
  let s = JSON.stringify(cleaned);
  if (!s || s.length <= maxChars) return cleaned;

  // Too big: shrink the largest array fields until it fits, so the caller keeps its
  // control fields (ok/code/error) and a usable head of the data.
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    const arrayKeys = Object.keys(cleaned)
      .filter((k) => Array.isArray(cleaned[k]))
      .sort((a, b) => cleaned[b].length - cleaned[a].length);
    const originalLengths = Object.fromEntries(arrayKeys.map((k) => [k, cleaned[k].length]));
    for (const k of arrayKeys) {
      while (cleaned[k].length > 1 && s.length > maxChars) {
        cleaned[k] = cleaned[k].slice(0, Math.floor(cleaned[k].length / 2));
        s = JSON.stringify(cleaned);
      }
      if (s.length <= maxChars) break;
    }
    const shrunk = arrayKeys.filter((k) => cleaned[k].length < originalLengths[k]);
    if (shrunk.length) {
      cleaned.truncated = true;
      cleaned.droppedItems = Object.fromEntries(
        shrunk.map((k) => [k, { returned: cleaned[k].length, total: originalLengths[k] }]),
      );
      cleaned.truncationNote = 'result shortened to fit the agent context — re-run with a narrower range/filter for the rest';
      // A sibling scalar that still reports the FULL length (count/total/limit) would tell
      // the model it has 50 rows while only 25 survive, and it would reason over rows that
      // are not in front of it. Correct any counter that matched a shrunk array.
      for (const k of shrunk) {
        for (const counter of ['count', 'total', 'totalCount', 'limit']) {
          if (cleaned[counter] === originalLengths[k]) cleaned[counter] = cleaned[k].length;
        }
      }
      s = JSON.stringify(cleaned);
    }
    if (s.length <= maxChars) return cleaned;
  }

  // Last resort (no arrays to shrink, or still oversized): keep the control fields.
  const control = {};
  for (const k of ['ok', 'code', 'error', 'retryable']) {
    if (cleaned && typeof cleaned === 'object' && k in cleaned) control[k] = cleaned[k];
  }
  return { ...control, truncated: true, preview: s.slice(0, maxChars) };
}
