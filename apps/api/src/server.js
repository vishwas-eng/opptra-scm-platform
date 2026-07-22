// API entrypoint. Boot order: config → migrations → plugins → routes → listen.
// Anything wrong at boot exits non-zero so Docker restarts us loudly.
process.env.SERVICE_NAME = 'api';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config, logger, migrate, closeDb } from '@opptra/core';
import { closeQueues } from './queue.js';

const cfg = config();
const here = path.dirname(fileURLToPath(import.meta.url));

// 1. Migrations run at boot — API and worker race safely (advisory via _migrations PK).
const migrationsDir = path.join(here, '../../../packages/core/src/migrations');
await migrate(migrationsDir);

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true, // behind Caddy
  bodyLimit: 1 * 1024 * 1024,
});

await app.register(import('@fastify/rate-limit'), {
  max: 300, timeWindow: '1 minute',
  allowList: (req) => req.url === '/healthz',
});

await app.register(import('./plugins/auth.js'));
await app.register(import('./routes/core.js'));
await app.register(import('./routes/admin.js'));
await app.register(import('./routes/automations.js'));

// Static web app (single container serves UI + API; Caddy handles TLS).
await app.register(import('@fastify/static'), {
  root: path.join(here, '../../web/public'),
  prefix: '/',
});
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html'); // SPA fallback
});

app.setErrorHandler((err, req, reply) => {
  if (err.validation) return reply.code(400).send({ error: 'invalid input', detail: err.message });
  req.log.error({ err }, 'unhandled route error');
  return reply.code(500).send({ error: 'internal error' });
});

// Graceful shutdown — finish in-flight requests, close pools, exit.
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
