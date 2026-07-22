// CLI entry: node packages/core/src/migrate.js
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate, closeDb } from './db.js';
import { logger } from './logger.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

try {
  await migrate(dir);
  logger.info('migrations up to date');
} catch (err) {
  logger.error({ err }, 'migration run failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
