// Google Workspace refresh tokens:
//   - google_oauth_token (id=1)  → shared admin grant for Sheets / Sheet Update
//   - user_google_oauth           → per-user grant for Packing Mail (draft/send from their Gmail)
import { query } from './db.js';

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
  if (!email) return { refresh_token: '', granted_by: '', scope: '' };
  const { rows } = await query(
    'SELECT user_email, refresh_token, granted_by, scope, updated_at FROM user_google_oauth WHERE user_email = $1',
    [email],
  );
  return rows[0] || { user_email: email, refresh_token: '', granted_by: '', scope: '' };
}

export async function setUserGoogleOAuthToken({ userEmail, refreshToken, grantedBy, scope }) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) throw new Error('userEmail is required to store a Google OAuth token');
  await query(
    `INSERT INTO user_google_oauth (user_email, refresh_token, granted_by, scope, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_email) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       granted_by = EXCLUDED.granted_by,
       scope = EXCLUDED.scope,
       updated_at = now()`,
    [email, refreshToken, grantedBy, scope],
  );
}

export async function clearUserGoogleOAuthToken(userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return;
  await query('DELETE FROM user_google_oauth WHERE user_email = $1', [email]);
}
