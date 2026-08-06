// One error shape for every connector, so the Agent, the UI and playbook runs can all
// branch on `code` instead of regex-matching English prose that changes when a vendor
// rewords their message.
//
// Shape: { ok: false, code, error, retryable, ...hints }
//   code, stable machine identifier from CONNECTOR_ERROR_CODES
//   error, human sentence (safe to show; never contains secrets)
//   retryable, true only when repeating the SAME call unchanged may succeed later.
//               Auth/permission/validation failures are NOT retryable: retrying them
//               burns quota and hides the real fix from the operator.

export const CONNECTOR_ERROR_CODES = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',       // connector not connected for this user
  COMING_SOON: 'COMING_SOON',           // connector exists in the UI but is not live yet
  AUTH_REQUIRED: 'AUTH_REQUIRED',       // no credential at all
  AUTH_EXPIRED: 'AUTH_EXPIRED',         // credential existed and died (revoked / session dead)
  SCOPE_MISSING: 'SCOPE_MISSING',       // authenticated but missing a permission scope
  PERMISSION_DENIED: 'PERMISSION_DENIED', // authenticated, scoped, but no access to THIS resource
  NOT_BOUND: 'NOT_BOUND',               // resource not bound under Connectors
  NOT_FOUND: 'NOT_FOUND',               // upstream says the object does not exist
  INVALID_INPUT: 'INVALID_INPUT',       // caller passed something unusable
  RATE_LIMITED: 'RATE_LIMITED',         // quota / 429
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',     // vendor 5xx or transport failure
  TIMEOUT: 'TIMEOUT',                   // we gave up waiting
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',     // action id not in the registry
  AWAITING_HAR: 'AWAITING_HAR',         // scaffolded action, no verified capture yet
  INTERNAL: 'INTERNAL',
});

const RETRYABLE_BY_DEFAULT = new Set([
  CONNECTOR_ERROR_CODES.RATE_LIMITED,
  CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
  CONNECTOR_ERROR_CODES.TIMEOUT,
]);

/**
 * Build a structured connector failure.
 * @param {string} code one of CONNECTOR_ERROR_CODES
 * @param {string} message human sentence
 * @param {object} [extra] hints merged into the result (e.g. { oauthUrl, resourceId })
 */
export function connectorError(code, message, extra = {}) {
  const known = Object.values(CONNECTOR_ERROR_CODES).includes(code);
  const finalCode = known ? code : CONNECTOR_ERROR_CODES.INTERNAL;
  const { retryable, ...hints } = extra || {};
  return {
    ok: false,
    code: finalCode,
    error: String(message || finalCode),
    retryable: retryable === undefined ? RETRYABLE_BY_DEFAULT.has(finalCode) : !!retryable,
    ...hints,
  };
}

/** True when the same call, unchanged, is worth repeating after a backoff. */
export function isRetryable(result) {
  return !!(result && result.ok === false && result.retryable);
}
