import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

let pool = null;

export function db() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  }
  return pool;
}

export async function query(text, params) {
  return db().query(text, params);
}

export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
}

/** Simple forward-only migration runner. Files in migrations/ run once, in order, in a tx. */
export async function migrate(migrationsDir, fsMod, pathMod) {
  const fs = fsMod || (await import('node:fs'));
  const path = pathMod || (await import('node:path'));
  await query(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Exclude dotfiles - macOS tar embeds AppleDouble metadata as "._001_init.sql" (still
  // ends in .sql, sorts before the real file since '.' < digits, and is binary garbage).
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.startsWith('.')).sort();
  for (const f of files) {
    const done = await query('SELECT 1 FROM _migrations WHERE name = $1', [f]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      logger.info({ migration: f }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, migration: f }, 'migration FAILED - aborting boot');
      throw err;
    } finally {
      client.release();
    }
  }
}
