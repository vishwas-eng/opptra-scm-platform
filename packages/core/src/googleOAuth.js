// Google Workspace refresh tokens:
//   - google_oauth_token (id=1)  → shared admin grant for Sheet Update / platform automations
//   - user_google_oauth           → per-user grant for Packing Mail + Agent Sheets/Drive tools
// Per-user refresh tokens are stored AES-256-GCM encrypted (prefix enc1:) using JWT_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { query } from './db.js';
import { config } from './config.js';

const ENC_PREFIX = 'enc1:';

function tokenKey() {
  // Derive a stable 32-byte key from JWT_SECRET (already required ≥32 chars).
  return createHash('sha256').update(String(config().JWT_SECRET || '')).digest();
}

/** Encrypt refresh token at rest. Plaintext legacy rows still read fine. */
export function encryptRefreshToken(plain) {
  const raw = String(plain || '');
  if (!raw) return '';
  if (raw.startsWith(ENC_PREFIX)) return raw; // already encrypted
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptRefreshToken(stored) {
  const raw = String(stored || '');
  if (!raw) return '';
  if (!raw.startsWith(ENC_PREFIX)) return raw; // legacy plaintext
  try {
    const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt Google refresh token, reconnect Google on Connectors');
  }
}

export async function getGoogleOAuthToken() {
  const { rows } = await query('SELECT refresh_token, granted_by, scope, updated_at FROM google_oauth_token WHERE id = 1');
  return rows[0] || { refresh_token: '', granted_by: '', scope: '' };
}

export async function setGoogleOAuthToken({ refreshToken, grantedBy, scope }) {
  await query(
    `UPDATE google_oauth_token SET refresh_token = $1, granted_by = $2, scope = $3, updated_at = now() WHERE id = 1`,
    [refreshToken, grantedBy, scope]
  );
}

export async function getUserGoogleOAuthToken(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return { refresh_token: '', granted_by: '', scope: '', google_email: '', last_error: '' };
  const { rows } = await query(
    `SELECT user_email, refresh_token, granted_by, scope, updated_at,
            COALESCE(google_email, '') AS google_email,
            COALESCE(last_error, '') AS last_error,
            last_ok_at
     FROM user_google_oauth WHERE user_email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) return { user_email: email, refresh_token: '', granted_by: '', scope: '', google_email: '', last_error: '' };
  return { ...row, refresh_token: decryptRefreshToken(row.refresh_token) };
}

export async function setUserGoogleOAuthToken({ userEmail, refreshToken, grantedBy, scope, googleEmail }) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) throw new Error('userEmail is required to store a Google OAuth token');
  const gEmail = String(googleEmail || grantedBy || '').trim().toLowerCase();
  const stored = encryptRefreshToken(refreshToken);
  await query(
    `INSERT INTO user_google_oauth (user_email, refresh_token, granted_by, scope, google_email, last_error, last_ok_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '', now(), now())
     ON CONFLICT (user_email) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       granted_by = EXCLUDED.granted_by,
       scope = EXCLUDED.scope,
       google_email = EXCLUDED.google_email,
       last_error = '',
       last_ok_at = now(),
       updated_at = now()`,
    [email, stored, grantedBy, scope, gEmail],
  );
}

export async function clearUserGoogleOAuthToken(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return;
  await query('DELETE FROM user_google_oauth WHERE user_email = $1', [email]);
}

export async function markUserGoogleOAuthError(userEmail, error) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return;
  await query(
    `UPDATE user_google_oauth SET last_error = $2, updated_at = now() WHERE user_email = $1`,
    [email, String(error || '').slice(0, 500)],
  );
}

export async function markUserGoogleOAuthOk(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return;
  await query(
    `UPDATE user_google_oauth SET last_error = '', last_ok_at = now(), updated_at = now() WHERE user_email = $1`,
    [email],
  );
}

/** Required scopes for Agent Sheets + Drive tools (same grant as Packing Mail). */
export const AGENT_GOOGLE_SCOPE_NEEDLES = [
  'spreadsheets',
  'drive.readonly',
];

export function userGoogleScopeStatus(scopeStr = '') {
  const s = String(scopeStr || '');
  const hasSheets = /spreadsheets/i.test(s);
  const hasDrive = /drive(\.readonly|\.file)?/i.test(s) || /auth\/drive/i.test(s);
  return {
    hasSheets,
    hasDrive,
    ok: hasSheets && hasDrive,
    missing: [
      ...(!hasSheets ? ['spreadsheets'] : []),
      ...(!hasDrive ? ['drive.readonly'] : []),
    ],
  };
}
