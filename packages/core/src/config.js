// Central, validated configuration. The process refuses to boot on invalid config —
// misconfiguration fails loud at startup, never silently at 2am inside a job.
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- Unicommerce (single whitelisted bot account) ---
  UC_BASE_URL: z.string().url(),
  UC_USER: z.string().default(''),
  UC_PASS: z.string().default(''),
  // Bridge until the whitelisted account lands: a manually captured JSESSIONID may be
  // seeded via env (or pasted in the Admin tab, which stores it in Postgres).
  UC_JSESSIONID_OVERRIDE: z.string().default(''),
  UC_DEFAULT_FACILITY: z.string().default(''),
  // Keep-alive cadence. Internal /data sessions idle out in minutes; 4 min is proven safe.
  UC_KEEPALIVE_MINUTES: z.coerce.number().int().min(1).max(30).default(4),
  // Global throttle so we never trip Unicommerce's rate limit. rps = sustained calls/sec
  // across ALL automations; burst = how many may fire back-to-back before pacing.
  UC_MAX_RPS: z.coerce.number().positive().max(50).default(4),
  UC_BURST: z.coerce.number().int().positive().max(100).default(8),

  // --- Inward / Outward / Full-cycle config (proven defaults from the Apps Script app) ---
  UC_VENDOR_CODE: z.string().default(''),
  UC_SHELF_CODE: z.string().default('DEFAULT'),
  UC_CURRENCY: z.string().default('INR'),
  UC_TAX_CODE: z.string().default(''),
  // ADJUST = bearer-only stock add (no session, cannot be blocked). GRN_PUTAWAY = full internal route.
  UC_INWARD_MODE: z.enum(['ADJUST', 'GRN_PUTAWAY']).default('ADJUST'),
  UC_GRN_TRAIL: z.coerce.boolean().default(true),
  UC_OUTWARD_CHANNEL: z.string().default('CUSTOM'), // B2C CUSTOM binds warehouse line items (not *_B2B)
  UC_OUTWARD_SHIP_METHOD: z.string().default('STD'),

  // --- Human auth (Google SSO) ---
  GOOGLE_CLIENT_ID: z.string().min(1),
  ALLOWED_DOMAIN: z.string().default('opptra.com'),
  ADMIN_EMAILS: z.string().default(''), // comma-separated; bootstrap admins
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

  // --- Alerting ---
  SLACK_WEBHOOK_URL: z.string().default(''),
  ALERT_EMAIL: z.string().default(''),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

let cached = null;

export function config() {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`FATAL: invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  cached = Object.freeze({
    ...parsed.data,
    isProd: parsed.data.NODE_ENV === 'production',
    adminEmails: parsed.data.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
  return cached;
}

// Test hook only.
export function _resetConfigForTests() { cached = null; }
