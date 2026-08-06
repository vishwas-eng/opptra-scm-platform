#!/usr/bin/env node
// Opptra relay agent — runs on a machine that is ALREADY inside a network the platform
// cannot reach (today: 6th Street's IBM Sterling OMS behind a Forti VPN).
//
//   OPPTRA_URL=https://scm.opptra.com OPPTRA_TOKEN=<token> \
//   STREET6_OMS_USER=... STREET6_OMS_PASS=... \
//   node bin/opptra-relay.js --connector 6thstreet
//
// It only ever makes OUTBOUND HTTPS calls to the platform, so there is no inbound
// firewall rule to open, no site-to-site tunnel to provision, and MFA or split-tunnel
// on the VPN is irrelevant — a human already authenticated this machine.
//
// Logs go to stderr; stdout stays clean for piping status.
import { hostname } from 'node:os';
import { fetchPackDocuments } from '../src/oms.js';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const platform = (arg('--url', process.env.OPPTRA_URL) || '').replace(/\/+$/, '');
const token = arg('--token', process.env.OPPTRA_TOKEN) || '';
const connectorId = arg('--connector', '6thstreet');
const pollMs = Number(arg('--poll', process.env.OPPTRA_RELAY_POLL_MS || 15_000));
const agentId = arg('--agent-id', process.env.OPPTRA_AGENT_ID || hostname());

if (!platform || !token) {
  console.error('relay: need --url/--token (or OPPTRA_URL/OPPTRA_TOKEN). Create a token in Admin → Access tokens.');
  process.exit(2);
}

const log = (...a) => console.error(new Date().toISOString(), ...a);

async function api(path, body) {
  const res = await fetch(`${platform}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(data?.error || `platform ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Job handlers, keyed by kind. Each returns { artifacts, result }. */
const HANDLERS = {
  'oms.packDocs': (payload) => fetchPackDocuments(payload, { log }),
};

async function runOnce() {
  const claim = await api('/api/relay/claim', { connectorId, agentId });
  if (!claim?.job) return false;

  const { job } = claim;
  log(`claimed ${job.kind} ${job.job_uid} (attempt ${job.attempts})`);

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await api(`/api/relay/jobs/${job.job_uid}/result`, {
      agentId, error: `this agent has no handler for kind "${job.kind}"`,
    });
    return true;
  }

  try {
    const { artifacts = [], result = {} } = await handler(job.payload || {});
    await api(`/api/relay/jobs/${job.job_uid}/result`, { agentId, artifacts, result });
    log(`done ${job.job_uid} — ${artifacts.length} artifact(s)`);
  } catch (err) {
    log(`failed ${job.job_uid}: ${err.message}`);
    // Report the failure so the job stops being retried blindly; the platform counts
    // attempts and gives up rather than looping forever.
    await api(`/api/relay/jobs/${job.job_uid}/result`, {
      agentId, error: String(err.message || err).slice(0, 2000),
    }).catch(() => {});
  }
  return true;
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log('shutting down after the current job'); });
}

log(`relay agent "${agentId}" → ${platform} (connector ${connectorId}, poll ${pollMs}ms)`);
while (!stopping) {
  try {
    // Drain the queue before sleeping, so a batch of orders does not trickle out one
    // per poll interval.
    let worked = await runOnce();
    while (worked && !stopping) worked = await runOnce();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      log(`auth rejected (${err.message}) — fix the token and restart`);
      process.exit(1);
    }
    log(`poll error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
process.exit(0);
