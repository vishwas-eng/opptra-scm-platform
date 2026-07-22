// Google Workspace integration — Gmail / Drive / Sheets via a service account with
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
  if (!saKeyJson) throw new Error('GOOGLE_SA_KEY_JSON not set — Google integration unavailable');
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

export const gmailApi = {
  createDraft: (gmail, mail) =>
    gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: buildRawMessage(mail) } } }),
  send: (gmail, mail) =>
    gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawMessage(mail) } }),
};

export const driveApi = {
  listFolder: async (drive, folderId) => {
    const res = await drive.files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'files(id,name,mimeType)', pageSize: 1000 });
    return res.data.files || [];
  },
  getFileBytes: async (drive, fileId) => {
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  },
};

export const sheetsApi = {
  read: async (sheets, spreadsheetId, range) => {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  },
  append: (sheets, spreadsheetId, range, rows) =>
    sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: rows } }),
  update: (sheets, spreadsheetId, range, rows) =>
    sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: rows } }),
};
