// Google Workspace integration - Gmail / Drive / Sheets, three interchangeable auth modes
// (tried in this priority order). The clients are INJECTED (googleClients()), so automation
// code and tests depend on small, mockable wrappers rather than googleapis directly.
//
// Runtime config (validated in @opptra/core):
//   1. refreshToken + clientId + clientSecret   - a real Workspace user authorized once via
//      a normal OAuth consent screen (/auth/google/connect). No service account, no IAM
//      grant, no Workspace Super Admin step - the fallback when those are blocked.
//   2. GOOGLE_SA_KEY_JSON  base64 of a service-account key JSON (classic path - only
//                          works where key export is allowed; many orgs block it)
//   3. GOOGLE_SA_EMAIL     service-account email for the KEYLESS path (no exported key -
//                          the caller's own ambient credentials (e.g. a GCE VM's attached
//                          service account) sign short-lived DWD assertions remotely via
//                          the IAM Credentials API. Requires roles/iam.serviceAccountTokenCreator
//                          on this service account, granted to the caller's identity.
//   GOOGLE_DELEGATED_USER  the Workspace user to impersonate - only used by modes 2 and 3.
import { buildRawMessage } from './mime.js';

export { buildRawMessage } from './mime.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

/** Build authorized googleapis clients from config. Lazy-imports googleapis so the
 *  package can be loaded (and unit-tested via wrappers) without credentials present. */
export async function googleClients({ saKeyJson, saEmail, delegatedUser, refreshToken, clientId, clientSecret }) {
  const { google } = await import('googleapis');
  let auth; let delegatedUserResolved = delegatedUser;
  if (refreshToken) {
    if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set for the refresh-token auth mode.');
    auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    delegatedUserResolved = delegatedUser || '(oauth-connected account)';
  } else if (saKeyJson) {
    if (!delegatedUser) throw new Error('GOOGLE_DELEGATED_USER not set. Google integration unavailable.');
    const key = JSON.parse(Buffer.from(saKeyJson, 'base64').toString('utf8'));
    auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES, subject: delegatedUser });
    await auth.authorize();
  } else if (saEmail) {
    if (!delegatedUser) throw new Error('GOOGLE_DELEGATED_USER not set. Google integration unavailable.');
    auth = await makeKeylessDelegatedClient({ saEmail, delegatedUser, scopes: SCOPES });
  } else {
    throw new Error('Set a refresh token, GOOGLE_SA_KEY_JSON, or GOOGLE_SA_EMAIL to enable Google Workspace integration.');
  }
  return {
    gmail: google.gmail({ version: 'v1', auth }),
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
    delegatedUser: delegatedUserResolved,
  };
}

// Domain-wide-delegation without ever exporting a private key. The caller's own ambient
// credentials (Application Default Credentials - a GCE VM's attached service account, or a
// developer's `gcloud auth application-default login`) call IAM Credentials' signJwt to have
// Google sign the DWD assertion server-side, then exchange it for an access token exactly
// like the classic JWT flow. Needs roles/iam.serviceAccountTokenCreator on `saEmail`.
async function getKeylessDelegatedToken({ saEmail, delegatedUser, scopes }) {
  const { GoogleAuth } = await import('google-auth-library');
  const adc = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await adc.getClient();
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: saEmail, scope: scopes.join(' '), aud: 'https://oauth2.googleapis.com/token', sub: delegatedUser, iat: now, exp: now + 3600 };
  const signRes = await client.request({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signJwt`,
    method: 'POST',
    data: { payload: JSON.stringify(claim) },
  });
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signRes.data.signedJwt }),
  });
  if (!tokenRes.ok) throw new Error(`keyless domain-wide delegation token exchange failed (HTTP ${tokenRes.status}): ${await tokenRes.text()}`);
  const { access_token, expires_in } = await tokenRes.json();
  return { access_token, expiry_date: Date.now() + expires_in * 1000 };
}

async function makeKeylessDelegatedClient({ saEmail, delegatedUser, scopes }) {
  const { OAuth2Client } = await import('google-auth-library');
  const oauth2 = new OAuth2Client();
  oauth2.refreshHandler = () => getKeylessDelegatedToken({ saEmail, delegatedUser, scopes });
  return oauth2;
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
  // threadId (optional) appends the draft to an existing conversation - Gmail threads
  // it when the subject also matches the thread's subject.
  createDraft: (gmail, mail, { threadId } = {}) => withGoogleRetry(() =>
    gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: buildRawMessage(mail), ...(threadId ? { threadId } : {}) } } })),
  send: (gmail, mail) => withGoogleRetry(() =>
    gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawMessage(mail) } })),
  // Dispatch a draft created earlier via createDraft - lets an operator view it in
  // Gmail first, then send that exact reviewed draft rather than composing again.
  sendDraft: (gmail, draftId) => withGoogleRetry(() =>
    gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } })),
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
  // Legacy findPdfInFolder_: exact-name match "{base}.pdf" / "{base}.PDF" / "{base}"
  // inside one folder; returns the file bytes or null. Never throws (attachments are
  // always soft-fail in the packing flow).
  findPdfByName: async (drive, folderId, baseName) => {
    if (!folderId || !baseName) return null;
    try {
      const esc = String(baseName).replace(/['\\]/g, ' ');
      const q = `'${folderId}' in parents and trashed = false and (name = '${esc}.pdf' or name = '${esc}.PDF' or name = '${esc}')`;
      const res = await withGoogleRetry(() => drive.files.list({ q, fields: 'files(id,name)', pageSize: 3 }));
      const file = res.data.files?.[0];
      if (!file) return null;
      const bytes = await withGoogleRetry(() => drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' }));
      return Buffer.from(bytes.data);
    } catch { return null; }
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
  clear: (sheets, spreadsheetId, range) => withGoogleRetry(() =>
    sheets.spreadsheets.values.clear({ spreadsheetId, range })),
  // Many discontiguous single-cell/row writes in one HTTP call (patching a sheet by
  // header name touches scattered columns - one request beats N sequential updates).
  batchUpdateValues: (sheets, spreadsheetId, data) => withGoogleRetry(() =>
    sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data } })),
  listTabs: async (sheets, spreadsheetId) => {
    const meta = await withGoogleRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }));
    return (meta.data.sheets || []).map((s) => s.properties.title);
  },
  // Make a new tab look exactly like the template tab's header block: values AND
  // formatting (colours, bold, fonts) via copyPaste, plus column widths and frozen
  // header rows - a plain values-write leaves an unstyled tab that ops won't accept.
  cloneHeaderFormatting: async (sheets, spreadsheetId, fromTab, toTab, headerRows = 2) => {
    const meta = await withGoogleRetry(() => sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`'${fromTab.replace(/'/g, "''")}'!A1:ZZ1`],
      fields: 'sheets(properties(sheetId,title),data(columnMetadata(pixelSize)))',
    }));
    const all = await withGoogleRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' }));
    const findId = (title) => (all.data.sheets || []).find((s) => s.properties.title === title)?.properties.sheetId;
    const fromId = findId(fromTab); const toId = findId(toTab);
    if (fromId === undefined || toId === undefined) return;
    const widths = meta.data.sheets?.[0]?.data?.[0]?.columnMetadata || [];
    const nCols = Math.max(widths.length, 26);
    const requests = [
      { copyPaste: { source: { sheetId: fromId, startRowIndex: 0, endRowIndex: headerRows, startColumnIndex: 0, endColumnIndex: nCols },
        destination: { sheetId: toId, startRowIndex: 0, endRowIndex: headerRows, startColumnIndex: 0, endColumnIndex: nCols }, pasteType: 'PASTE_NORMAL' } },
      { updateSheetProperties: { properties: { sheetId: toId, gridProperties: { frozenRowCount: headerRows } }, fields: 'gridProperties.frozenRowCount' } },
      ...widths.map((w, i) => (w.pixelSize ? { updateDimensionProperties: {
        range: { sheetId: toId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w.pixelSize }, fields: 'pixelSize' } } : null)).filter(Boolean),
    ];
    await withGoogleRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
  },
  // Create a tab if it doesn't exist. Returns true if it was created.
  ensureTab: async (sheets, spreadsheetId, title) => {
    const meta = await withGoogleRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }));
    const exists = (meta.data.sheets || []).some((s) => s.properties.title === title);
    if (!exists) await withGoogleRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } }));
    return !exists;
  },
  // Grow a tab's grid so an explicit-range write below the current rowCount can't fail.
  ensureGridRows: async (sheets, spreadsheetId, title, minRows) => {
    const meta = await withGoogleRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title,gridProperties.rowCount)' }));
    const sheet = (meta.data.sheets || []).find((s) => s.properties.title === title);
    const rowCount = sheet?.properties?.gridProperties?.rowCount;
    if (rowCount && rowCount < minRows) {
      await withGoogleRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', length: minRows - rowCount } }] } }));
    }
  },
};

// A1 range with a properly single-quoted sheet name (required when the name has a space).
export const a1 = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;
