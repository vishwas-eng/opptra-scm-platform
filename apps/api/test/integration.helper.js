// Real integration harness: points the app at a dedicated local Postgres + an isolated
// Redis db, resets the schema, runs migrations, and hands back an authenticated agent.
// node:test runs each test file in its own process, so setting env here is safe.
import { execFileSync } from 'node:child_process';

const PSQL = '/opt/homebrew/opt/postgresql@16/bin/psql';

export function setTestEnv() {
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = 'postgres://opptra:localdev@127.0.0.1:5432/opptra_test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379/15'; // isolated Redis db
  process.env.UC_BASE_URL = 'https://oppdoorstg.unicommerce.com';
  process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
  process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789';
  process.env.PUBLIC_URL = 'http://localhost:8080';
  process.env.ADMIN_EMAILS = 'vishwas.pandey@opptra.com';
}

/** Wipe the public schema so every integration run starts clean, then migrate. */
export async function resetAndMigrate() {
  execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'opptra', '-d', 'opptra_test', '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { env: { ...process.env, PGPASSWORD: 'localdev' }, stdio: 'pipe' });
  // flush the isolated Redis db so no stale jobs bleed across runs
  try { execFileSync('redis-cli', ['-n', '15', 'flushdb'], { stdio: 'pipe' }); } catch { /* redis-cli optional */ }
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { migrate } = await import('@opptra/core');
  await migrate(path.join(here, '../../../packages/core/src/migrations'));
}

/** A tiny cookie-aware client over app.inject. */
export function agent(app) {
  let cookie = '';
  const capture = (res) => {
    const sc = res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
    const m = arr.find((c) => c.startsWith('opptra_session='));
    if (m) cookie = m.split(';')[0];
    return res;
  };
  const headers = () => (cookie ? { cookie } : {});
  return {
    async devLogin() { return capture(await app.inject({ method: 'POST', url: '/auth/dev-login' })); },
    get: (url) => app.inject({ method: 'GET', url, headers: headers() }),
    post: (url, payload) => app.inject({ method: 'POST', url, payload, headers: headers() }),
    del: (url) => app.inject({ method: 'DELETE', url, headers: headers() }),
    raw: (opts) => app.inject({ ...opts, headers: { ...headers(), ...(opts.headers || {}) } }),
    capture,
    clearCookie() { cookie = ''; },
  };
}
