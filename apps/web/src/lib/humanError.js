// Turn a technical failure into something an operator can act on.
//
// The people using this run a supply chain, not a server. "UPSTREAM_ERROR 503 on
// /services/rest/v1/oms/saleOrder/create" tells them nothing they can do. What they need
// is what went wrong, whether it is their problem, and what to try next.
//
// The raw text is never thrown away, it moves behind "Technical details" for admins.

const RULES = [
  {
    match: /no unicommerce session|session expired|USER_NOT_LOGGED_IN|needs_relogin|jsessionid/i,
    title: 'Unicommerce is signed out',
    detail: 'The shared Unicommerce session has expired, so nothing can talk to the OMS right now.',
    fix: 'An admin needs to reconnect Unicommerce from Scheduled Jobs. It takes about a minute.',
  },
  {
    match: /AUTH_REQUIRED|not connected|Connect .* first|no credential/i,
    title: 'That account is not connected yet',
    detail: 'This job needs a channel account that has not been linked.',
    fix: 'Open Connectors and connect the account, then run this again.',
  },
  {
    match: /AUTH_EXPIRED|reconnect|revoked|refresh token/i,
    title: 'The connection needs renewing',
    detail: 'The saved login for this channel is no longer accepted.',
    fix: 'Open Connectors and reconnect that account.',
  },
  {
    match: /incorrect username or password|invalid credential|bad credential/i,
    title: 'Wrong username or password',
    detail: 'The channel rejected the saved login details.',
    fix: 'Check the credentials with whoever owns the account. Do not keep retrying, repeated failures can lock it.',
  },
  {
    match: /RATE_LIMITED|429|too many requests|throttl/i,
    title: 'The channel is asking us to slow down',
    detail: 'We are sending requests faster than this channel allows.',
    fix: 'Nothing to do. It will pick up again shortly. If it keeps happening, run smaller batches.',
  },
  {
    match: /blocked|CAPTCHA|FORBIDDEN|403/i,
    title: 'The channel has blocked us',
    detail: 'The portal stopped responding normally, which usually means it thinks the traffic is automated.',
    fix: 'This is paused on purpose to protect the account. Tell the team before running it again.',
  },
  {
    match: /budget|daily request/i,
    title: 'Daily limit reached for this channel',
    detail: 'We cap how much we ask of each portal in a day to keep the account safe.',
    fix: 'It resets on a rolling 24 hour window. Try again later.',
  },
  {
    match: /INVALID_INPUT|invalid params|validation|required/i,
    title: 'Something in the form is not right',
    detail: 'One of the values sent with this job was not accepted.',
    fix: 'Check the order numbers or SKUs you entered and try again.',
  },
  {
    match: /NOT_FOUND|404|does not exist|no such/i,
    title: 'That could not be found',
    detail: 'The order, SKU or file this job asked for does not exist on the other side.',
    fix: 'Double check the reference. It may have been cancelled or not synced yet.',
  },
  {
    match: /timeout|timed out|ETIMEDOUT|took longer/i,
    title: 'The other system did not answer in time',
    detail: 'The channel was too slow to respond.',
    fix: 'This usually clears by itself. Try again in a few minutes.',
  },
  {
    match: /ECONNREFUSED|ENOTFOUND|network|fetch failed|socket/i,
    title: 'Could not reach the other system',
    detail: 'We could not open a connection to the channel.',
    fix: 'If this is 6th Street, the VPN relay may not be running. Otherwise it is usually temporary.',
  },
  {
    match: /awaitingHar|awaiting sanitized|not live yet|COMING_SOON/i,
    title: 'This channel is not switched on yet',
    detail: 'We have the groundwork in place but this channel is not connected for real use.',
    fix: 'Nothing to do here for now.',
  },
  {
    match: /VPN|relay|drop folder|OMS/i,
    title: '6th Street documents are not available',
    detail: '6th Street keeps picklists, invoices and labels behind its VPN, so they have to come through the relay.',
    fix: 'Make sure the relay is running on a machine connected to the VPN, or drop the files into the shared folder.',
  },
  {
    match: /SKU|catalog|mapping/i,
    title: 'A product code did not match',
    detail: 'A SKU on this order does not line up with the catalogue on the other side.',
    fix: 'Check the product mapping for that item before running this again.',
  },
];

const FALLBACK = {
  title: 'That did not work',
  detail: 'The job stopped before it finished.',
  fix: 'Try once more. If it keeps failing, send this to the team with the run reference.',
};

/**
 * @param {string|Error|object} error raw error, message, or a failed result
 * @returns {{ title: string, detail: string, fix: string, raw: string }}
 */
export function humanError(error) {
  const raw = typeof error === 'string'
    ? error
    : String(error?.error || error?.message || error?.detail || '');

  const hit = RULES.find((r) => r.match.test(raw));
  return { ...(hit || FALLBACK), raw };
}

/** Plain wording for a run status. */
export const RUN_STATUS_TEXT = {
  queued: 'Waiting to start',
  running: 'Working on it',
  pending_retry: 'Trying again',
  succeeded: 'Finished',
  failed: 'Did not finish',
};

/**
 * Short, readable summary of what a finished job actually did, from the shapes our
 * pipelines return. Falls back to nothing rather than inventing a claim.
 */
export function humanSummary(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];

  if (result.empty) return 'There was nothing new to process.';
  if (typeof result.fetched === 'number') bits.push(`${result.fetched} found`);
  if (typeof result.okCount === 'number') bits.push(`${result.okCount} done`);
  if (typeof result.created === 'number' && result.created) bits.push(`${result.created} created`);
  if (typeof result.skuCount === 'number') bits.push(`${result.skuCount} products`);
  if (typeof result.draftCount === 'number') bits.push(`${result.draftCount} drafts`);
  if (typeof result.lineCount === 'number') bits.push(`${result.lineCount} lines`);
  if (typeof result.failed === 'number' && result.failed) bits.push(`${result.failed} failed`);

  if (result.dryRun) bits.push('preview only, nothing was changed');
  return bits.join(', ');
}
