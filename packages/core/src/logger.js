import pino from 'pino';

// LOG_LEVEL / SERVICE_NAME are read straight from the environment (not validated
// config) on purpose: the logger must stay dependency-free so importing it never
// forces full config validation (tests import it without a complete env).
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'platform' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Never let secrets or session cookies reach the logs.
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.jsessionid', '*.password', '*.access_token'],
    censor: '[redacted]',
  },
});
