#!/usr/bin/env node
// Deploy preflight. Run BEFORE ./deploy/update.sh so a bad deploy is caught here,
// on a laptop, in two seconds — not on the VM after the containers are already down.
//
//   node scripts/preflight.js [path-to-env-file]
//
// Exit code 1 means do not deploy.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.resolve(process.argv[2] || path.join(ROOT, '.env'));

const problems = [];
const warnings = [];
const ok = [];

function check(label, condition, detail, { fatal = true } = {}) {
  if (condition) ok.push(label);
  else (fatal ? problems : warnings).push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------ the built SPA ------------------------------ */
// The API serves apps/web/dist. Without it every page 404s, and the failure only
// shows up in a browser — the health check still passes.
const dist = path.join(ROOT, 'apps/web/dist');
check('SPA built (apps/web/dist/index.html)', existsSync(path.join(dist, 'index.html')),
  'run: npm run build:web');
check('SPA assets present', existsSync(path.join(dist, 'assets')), 'the build produced no assets');
check('extension zips bundled into dist/downloads',
  existsSync(path.join(dist, 'downloads/opptra-session-helper.zip')),
  'run: bash scripts/build-extensions.sh && npm run build:web', { fatal: false });

// A dist older than the newest source file means someone edited and forgot to rebuild.
if (existsSync(path.join(dist, 'index.html'))) {
  const builtAt = statSync(path.join(dist, 'index.html')).mtimeMs;
  let newestSrc = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else newestSrc = Math.max(newestSrc, statSync(p).mtimeMs);
    }
  };
  walk(path.join(ROOT, 'apps/web/src'));
  check('SPA build is newer than its sources', builtAt >= newestSrc,
    'sources changed after the last build — run: npm run build:web', { fatal: false });
}

/* -------------------------------- migrations -------------------------------- */
// macOS tar can embed "._foo" AppleDouble files; one next to a migration still ends
// in .sql, sorts first, and crashes the migration runner with binary garbage.
const migDir = path.join(ROOT, 'packages/core/src/migrations');
const migs = readdirSync(migDir).filter((f) => f.endsWith('.sql'));
check('no AppleDouble files beside migrations', !migs.some((f) => f.startsWith('._')),
  `found: ${migs.filter((f) => f.startsWith('._')).join(', ')}`);
check('migrations are sequentially numbered',
  migs.map((f) => f.slice(0, 3)).every((n, i, a) => a.indexOf(n) === i),
  'duplicate migration numbers would apply in an ambiguous order');

/* ---------------------------------- env ---------------------------------- */
if (!existsSync(envPath)) {
  problems.push(`env file not found at ${envPath}`);
} else {
  const env = Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );

  for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'UC_BASE_URL', 'PUBLIC_URL']) {
    check(`${key} set`, !!env[key]);
  }
  check('JWT_SECRET is at least 32 chars', (env.JWT_SECRET || '').length >= 32);

  // The one that silently costs data: seal with the JWT-derived fallback today, set
  // VAULT_KEY tomorrow, and every sealed row becomes unopenable.
  check('VAULT_KEY set (pin it BEFORE first boot, or sealed rows orphan later)',
    !!env.VAULT_KEY, 'generate with: openssl rand -base64 32');
  if (env.VAULT_KEY) {
    const raw = env.VAULT_KEY.trim();
    const bytes = /^[0-9a-f]{64}$/i.test(raw) ? 32 : Buffer.from(raw, 'base64').length;
    check('VAULT_KEY is exactly 32 bytes', bytes === 32, `got ${bytes} bytes`);
  }

  check('GOOGLE_CLIENT_ID set (sign-in fails without it)', !!env.GOOGLE_CLIENT_ID);
  check('ADMIN_EMAILS set (nobody can administer the platform otherwise)', !!env.ADMIN_EMAILS,
    '', { fatal: false });

  if (env.NODE_ENV === 'production') {
    check('PUBLIC_URL is https in production', (env.PUBLIC_URL || '').startsWith('https://'),
      'the session cookie is only marked Secure when PUBLIC_URL is https', { fatal: false });
    check('UC_JSESSIONID_OVERRIDE is empty in production', !env.UC_JSESSIONID_OVERRIDE,
      'a pinned dev cookie would override the real session vault', { fatal: false });
  }
}

/* -------------------------------- report -------------------------------- */
for (const line of ok) console.log(`  ok    ${line}`);
for (const line of warnings) console.log(`  warn  ${line}`);
for (const line of problems) console.log(`  FAIL  ${line}`);

console.log(`\n${ok.length} passed, ${warnings.length} warning(s), ${problems.length} failure(s)`);
if (problems.length) {
  console.error('\nDo not deploy until the failures above are fixed.');
  process.exit(1);
}
console.log('Preflight clear.');
