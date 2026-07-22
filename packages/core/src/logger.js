import pino from 'pino';
import { config } from './config.js';

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

export function childLogger(bindings) {
  return logger.child(bindings);
}

// Convenience: config() is imported here so any module using the logger also gets
// early config validation on boot.
export { config };
