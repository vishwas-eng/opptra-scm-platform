// Builds the Fastify app (plugins + routes) WITHOUT running migrations or listening,
// so it can be exercised in tests via app.inject(). server.js wraps this for prod.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { logger } from '@opptra/core';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp({ withStatic = true } = {}) {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 1 * 1024 * 1024 });

  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // SheetJS (e-way bulk import) + Chart.js (KPI graphs) load from CDNs.
        scriptSrc: ["'self'", 'https://accounts.google.com', 'https://cdn.sheetjs.com', 'https://cdn.jsdelivr.net'],
        // blob: lets the in-page PDF/image previews render (generated files are served
        // to the iframe/img as blob URLs; without this the preview pane is just blank).
        frameSrc: ['https://accounts.google.com', 'https://docs.google.com', 'blob:'],
        connectSrc: ["'self'", 'https://accounts.google.com', 'https://cdn.sheetjs.com', 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
        frameAncestors: ["'none'"],
      },
    },
    // helmet's default Cross-Origin-Opener-Policy is "same-origin", which isolates the
    // browsing context group and breaks Google Identity Services' popup sign-in: the
    // popup opens and navigates fine but can never hand its result back to the opener,
    // so it just sits blank. "same-origin-allow-popups" keeps the isolation everywhere
    // except for windows we ourselves open (exactly this sign-in popup).
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  });

  await app.register(import('@fastify/rate-limit'), {
    max: 300, timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz',
  });

  // Reverse-DC uploads the credit-note PDF. Cap at 15 MB (a CN is well under 1 MB).
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  await app.register(import('./plugins/auth.js'));
  await app.register(import('./routes/core.js'));
  await app.register(import('./routes/ops.js'));
  await app.register(import('./routes/admin.js'));
  await app.register(import('./routes/googleAuth.js'));
  await app.register(import('./routes/automations.js'));

  if (withStatic) {
    await app.register(import('@fastify/static'), { root: path.join(here, '../../web/public'), prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'invalid input', detail: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'too many requests. Please slow down.' });
    if (err.statusCode === 503) return reply.code(503).send({ error: err.message });
    req.log.error({ err }, 'unhandled route error');
    return reply.code(500).send({ error: 'internal error' });
  });

  return app;
}
