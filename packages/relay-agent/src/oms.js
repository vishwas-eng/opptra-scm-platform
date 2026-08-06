// IBM Sterling OMS document fetch — runs ONLY inside the relay agent, on a machine
// already connected to the VPN.
//
// The exact request shapes are not decoded yet (no HAR has been captured from inside
// the tunnel — see docs/connectors/6thstreet-VPN.md). Two modes therefore exist:
//
//   1. FILE MODE (works today, no reverse-engineering needed) — the operator drops the
//      picklist/invoice/label into a watched folder and the agent uploads them. This is
//      the documented "Path B", finally reachable through the API.
//   2. HTTP MODE (unlocks once a HAR exists) — the agent logs into the OMS and fetches
//      the documents directly. Wire the real paths into fetchViaHttp below.
//
// Mode 1 exists because it removes the human from the *transport*, which is the slow
// part, without waiting on the VPN question to be answered.
import { readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const DOC_KINDS = [
  { key: 'picklist', re: /pick.?list/i },
  { key: 'invoice', re: /invoice/i },
  { key: 'label', re: /label|awb|shipping/i },
];

function classify(filename) {
  return DOC_KINDS.find((d) => d.re.test(filename))?.key || 'other';
}

/**
 * Collect documents for the requested orders from a watched directory.
 *
 * Matching is by order id appearing anywhere in the filename, which is how the OMS
 * names its downloads (`403770599_invoice.pdf`, `SAC082604817_label.pdf`).
 */
async function fetchFromDropFolder({ orderIds = [], dropDir }, { log } = {}) {
  const entries = await readdir(dropDir).catch(() => null);
  if (entries === null) throw new Error(`drop folder not readable: ${dropDir}`);

  const wanted = orderIds.map(String);
  const artifacts = [];
  const matched = [];

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const hit = wanted.find((id) => name.includes(id));
    if (!hit) continue;

    const full = path.join(dropDir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;

    artifacts.push({
      name,
      contentType: name.toLowerCase().endsWith('.pdf') ? 'application/pdf'
        : name.toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/octet-stream',
      base64: (await readFile(full)).toString('base64'),
    });
    matched.push({ file: name, orderId: hit, kind: classify(name) });
  }

  if (!artifacts.length) {
    throw new Error(`no files in ${dropDir} matched orders ${wanted.join(', ')} — download them from the OMS first`);
  }

  // Move consumed files aside so a re-run does not re-upload them. Failure to archive
  // is not fatal; the upload already succeeded by the time this matters.
  for (const m of matched) {
    await rename(path.join(dropDir, m.file), path.join(dropDir, `.sent-${m.file}`)).catch(() => {});
  }
  log?.(`drop folder: matched ${matched.length} file(s)`);
  return { artifacts, result: { mode: 'drop-folder', matched } };
}

/**
 * Direct OMS fetch. Intentionally unimplemented: the endpoints are not decoded and
 * guessing them against a production OMS would be both wrong and reckless.
 *
 * To implement, capture a HAR on the VPN while downloading the three documents for one
 * order, then map: login POST → session cookie, then one GET per document.
 */
async function fetchViaHttp() {
  throw new Error(
    'OMS HTTP mode is not wired yet — no HAR has been captured from inside the VPN. '
    + 'Use drop-folder mode (set STREET6_DROP_DIR), or capture a HAR per docs/connectors/6thstreet-VPN.md.',
  );
}

export async function fetchPackDocuments(payload = {}, ctx = {}) {
  const dropDir = payload.dropDir || process.env.STREET6_DROP_DIR || '';
  if (dropDir) return fetchFromDropFolder({ ...payload, dropDir }, ctx);
  return fetchViaHttp(payload, ctx);
}

export { classify as classifyDocument };
