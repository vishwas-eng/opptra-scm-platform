// Google Workspace integration - Gmail / Drive / Sheets via a service account with
// domain-wide delegation. The clients are INJECTED (googleClients()), so automation
// code and tests depend on small, mockable wrappers rather than googleapis directly.
//
// Runtime config (validated in @opptra/core once the SA key is provisioned):
//   GOOGLE_SA_KEY_JSON     base64 of the service-account key JSON
//   GOOGLE_DELEGATED_USER  the Workspace user to impersonate (e.g. supplychainauto@opptra.com)
import { buildRawMessage } from './mime.js';

export { buildRawMessage } from './mime.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

/** Build authorized googleapis clients from config. Lazy-imports googleapis so the
 *  package can be loaded (and unit-tested via wrappers) without credentials present. */
export async function googleClients({ saKeyJson, delegatedUser }) {
  if (!saKeyJson) throw new Error('GOOGLE_SA_KEY_JSON not set. Google integration unavailable.');
  const { google } = await import('googleapis');
  const key = JSON.parse(Buffer.from(saKeyJson, 'base64').toString('utf8'));
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES, subject: delegatedUser });
  await auth.authorize();
  return {
    gmail: google.gmail({ version: 'v1', auth }),
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
    delegatedUser,
  };
}

/* ---- thin, mockable wrappers (accept the client, do one thing) ---- */

// Google Sheets/Gmail have per-minute quotas; on GCP a burst can hit 429 rateLimitExceeded
// or 403 userRateLimitExceeded. Retry those (and 5xx) with exponential backoff so a
// transient quota blip never fails a run. Non-quota errors bubble immediately.
export async function withGoogleRetry(fn, { tries = 5 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const code = e?.code || e?.response?.status;
      const reason = JSON.stringify(e?.errors || e?.response?.data || e?.message || '');
      const retriable = code === 429 || (code === 403 && /rateLimit|quota|userRateLimit/i.test(reason)) || (code >= 500 && code < 600);
      if (!retriable || i === tries - 1) throw e;
      const wait = Math.min(32_000, 1000 * 2 ** i) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, wait));
      last = e;
    }
  }
  throw last;
}

export const gmailApi = {
  createDraft: (gmail, mail) => withGoogleRetry(() =>
    gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: buildRawMessage(mail) } } })),
  send: (gmail, mail) => withGoogleRetry(() =>
    gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawMessage(mail) } })),
};

export const driveApi = {
  listFolder: async (drive, folderId) => {
    const res = await withGoogleRetry(() => drive.files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'files(id,name,mimeType)', pageSize: 1000 }));
    return res.data.files || [];
  },
  getFileBytes: async (drive, fileId) => {
    const res = await withGoogleRetry(() => drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }));
    return Buffer.from(res.data);
  },
};

export const sheetsApi = {
  read: async (sheets, spreadsheetId, range) => {
    const res = await withGoogleRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range }));
    return res.data.values || [];
  },
  append: (sheets, spreadsheetId, range, rows) => withGoogleRetry(() =>
    sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: rows } })),
  update: (sheets, spreadsheetId, range, rows) => withGoogleRetry(() =>
    sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: rows } })),
  // Create a tab if it doesn't exist. Returns true if it was created.
  ensureTab: async (sheets, spreadsheetId, title) => {
    const meta = await withGoogleRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }));
    const exists = (meta.data.sheets || []).some((s) => s.properties.title === title);
    if (!exists) await withGoogleRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } }));
    return !exists;
  },
};

// A1 range with a properly single-quoted sheet name (required when the name has a space).
export const a1 = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;
