import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleClients } from '../src/index.js';

// googleClients() needs live cloud credentials for the keyed/keyless/refresh-token paths
// (a real SA key, real ADC + IAM permissions, or a real refresh token), so those aren't
// unit-tested here - only the fail-fast input validation, which is what protects against
// silent misconfig.

test('googleClients: saKeyJson mode requires GOOGLE_DELEGATED_USER', async () => {
  await assert.rejects(() => googleClients({ saKeyJson: 'x' }), /GOOGLE_DELEGATED_USER/);
});

test('googleClients: saEmail (keyless) mode requires GOOGLE_DELEGATED_USER', async () => {
  await assert.rejects(() => googleClients({ saEmail: 'sa@x.iam.gserviceaccount.com' }), /GOOGLE_DELEGATED_USER/);
});

test('googleClients: refreshToken mode requires clientId and clientSecret, not GOOGLE_DELEGATED_USER', async () => {
  await assert.rejects(() => googleClients({ refreshToken: 'rt' }), /GOOGLE_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET/);
});

test('googleClients: with nothing configured, lists all three options in the error', async () => {
  await assert.rejects(() => googleClients({}), /refresh token, GOOGLE_SA_KEY_JSON, or GOOGLE_SA_EMAIL/);
});

test('googleClients: refreshToken takes priority even if saKeyJson is also set (bad config), needing only its own creds', async () => {
  await assert.rejects(
    () => googleClients({ refreshToken: 'rt', saKeyJson: 'x' }), // no clientId/clientSecret
    /GOOGLE_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET/,
  );
});
