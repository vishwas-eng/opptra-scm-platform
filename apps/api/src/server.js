// API entrypoint. Boot order: config → migrations → build app → listen.
// Anything wrong at boot exits non-zero so Docker restarts us loudly.
process.env.SERVICE_NAME = 'api';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, logger, migrate, closeDb } from '@opptra/core';
import { closeQueues } from './queue.js';
import { buildApp } from './app.js';

const cfg = config();
const here = path.dirname(fileURLToPath(import.meta.url));

// 1. Migrations run at boot - API and worker race safely (via _migrations PK).
await migrate(path.join(here, '../../../packages/core/src/migrations'));

// 2. Build the app (plugins + routes + static).
const app = await buildApp();

// Global safety net: log loudly instead of dying silently on a missed rejection.
process.on('unhandledRejection', (err) => logger.error({ err }, 'UNHANDLED REJECTION'));

// Graceful shutdown - finish in-flight requests, close pools, exit.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down api');
    try {
      await app.close();
      await closeQueues();
      await closeDb();
    } finally {
      process.exit(0);
    }
  });
}

try {
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  logger.info({ port: cfg.PORT }, 'api listening');
} catch (err) {
  logger.error({ err }, 'api failed to start');
  process.exit(1);
}
