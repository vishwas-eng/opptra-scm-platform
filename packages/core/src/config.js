// Central, validated configuration. The process refuses to boot on invalid config -
// misconfiguration fails loud at startup, never silently at 2am inside a job.
import { z } from 'zod';

// Strict boolean from an env string. z.coerce.boolean() is Boolean(str), so "false"/"0"
// wrongly become true — a dangerous trap for flags like UC_RETURN_FILL_POOL (it would
// fire fabricated AWB pool numbers into production). Unset/empty uses the default.
const zbool = (def) => z.string().optional().transform((v) =>
  (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v).trim())));

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
  UC_GRN_TRAIL: zbool(true),
  UC_OUTWARD_CHANNEL: z.string().default('CUSTOM'), // B2C CUSTOM binds warehouse line items (not *_B2B)
  UC_OUTWARD_SHIP_METHOD: z.string().default('STD'),

  // --- Return + re-dispatch config (was raw process.env; now validated at boot) ---
  UC_RETURN_CHANNEL: z.string().default('CUSTOM_B2B'),
  UC_RETURN_B2B_CUSTOMER: z.string().default('OPPB2B01'),
  UC_RETURN_FILL_POOL: zbool(false), // top up AWB pool - staging only; off in prod
  UC_RETURN_POOL_PROVIDER: z.string().default('CUSTOM'),
  UC_RETURN_POOL_METHOD: z.string().default('Standard-Prepaid'),
  UC_RETURN_ALLOC_POLL: z.coerce.number().int().min(1).max(20).default(4),

  // --- ASN / Reverse-DC ---
  UC_ASN_FACILITIES: z.string().default(''), // comma list; RSG is always tried first
  UC_REVERSEDC_TO_LINES: z.string().default('Opptra Retail Private Limited'), // '|'-separated To block

  // --- Human auth (Google SSO) ---
  // Optional in dev (dev-login is used); the one-click deploy checks it is set for prod.
  GOOGLE_CLIENT_ID: z.string().default(''),
  // Needed only for the OAuth-consent Gmail/Sheets fallback (an admin authorizes once via
  // /auth/google/connect) - the Sign-In-with-Google login flow above never needs this.
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  ALLOWED_DOMAIN: z.string().default('opptra.com'),
  ADMIN_EMAILS: z.string().default(''), // comma-separated; bootstrap admins
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

  // --- Alerting ---
  // --- Google Workspace (packing-mail / sheet-update / reports-digest) ---
  // Base64 of the service-account key JSON + the Workspace user to impersonate.
  // Empty until domain-wide delegation is provisioned; those automations stay disabled.
  GOOGLE_SA_KEY_JSON: z.string().default(''), // classic path - blocked by org policy in opptra-applications
  GOOGLE_SA_EMAIL: z.string().default(''), // keyless path (default) - see integrations-google/src/index.js
  GOOGLE_DELEGATED_USER: z.string().default(''),
  // The working copy the platform owns (b2b-india-automation, already seeded from the
  // read-only source "B2B-VIEW-INDIA" sheet). Never point this at the source sheet.
  MASTER_SHEET_ID: z.string().default('1NdvqZ86ZquaSw1umyngeaXE_gVEM763TpuQw1mgngoQ'),
  // Packing mail: warehouse To/CC/Finance come from this Google Sheet (never hardcoded).
  // Share the sheet with GOOGLE_DELEGATED_USER. Layout: Warehouse Name | To | To | To | CC | CC | Finance
  WAREHOUSE_EMAIL_SHEET_ID: z.string().default('18vvm7Qem_f0qOrWQ6GGT6Mon-DxdhQjXOIZDgrGY4hA'),
  WAREHOUSE_EMAIL_TAB: z.string().default(''), // empty = first tab
  // Legacy JSON override kept only as a last-resort fallback in older deploys; prefer the sheet.
  WAREHOUSE_MAP: z.string().default('{}'),
  PACKING_DEFAULT_TO: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('SupplyChainAuto'),
  // Drive folders the ops team drops Amazon shipping labels ({PO}.pdf) and appointment
  // letters ({AppointmentID}.pdf) into - same folders the legacy Mailer.gs used.
  LABEL_DRIVE_FOLDER: z.string().default('19AVUm0xi2dYKAQ5ldyFG0q0bT-285o2E'),
  APPOINTMENT_DRIVE_FOLDER: z.string().default('1Qp-p1pd8YySXQpZkwciXAsAA5oH7c_VH'),
  // The READ-ONLY ops source sheet ("B2B-VIEW-INDIA") our working copy was seeded from.
  // syncFromSource pulls orders that exist there but not on our Master (add-missing-only,
  // never updates existing rows - that would clobber second-fill enrichments).
  SOURCE_SHEET_ID: z.string().default('1w5oEbhURFs3avukt3BpMHgQTZFQmUE7EDRXc6D2zi7Y'),
  SOURCE_MASTER_TAB: z.string().default('MasterSheet'),
  SHEET_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(60), // 0 disables the schedule
  // Sheet update (A1): Waypoint's own Neon Postgres (read-only) is the primary source for
  // first-fill - direct SQL, no session/cookie to keep alive. The CSV export below is kept
  // only as a fallback if the DB isn't reachable.
  WAYPOINT_DB_URL: z.string().default(''),
  WAYPOINT_BASE_URL: z.string().default('https://opptra-so-tracker.vercel.app'),
  WAYPOINT_COOKIE: z.string().default(''), // cookie only - no scripted login for Waypoint yet
  MASTER_TAB: z.string().default('Master'),
  SHEET_ENRICH_MAX_SOS: z.coerce.number().int().min(1).max(2000).default(200),

  // --- Vinculum (Home Centre sync) ---
  VINCULUM_BASE_URL: z.string().default('https://landmarkgroup.vinsupplier.com/eRetailWeb'),
  VINCULUM_USER: z.string().default(''),
  VINCULUM_PASS: z.string().default(''),
  // JSON map of named fulfill steps once HAR-captured (confirm/invoice/ship/label).
  VINCULUM_FULFILL_ACTIONS_JSON: z.string().default(''),
  // How often to poll HC orders (minutes). 0 = disabled schedule.
  HC_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),
  // UC B2C punch settings for Home Centre (GCC)
  HC_UC_CHANNEL: z.string().default('CUSTOM'),
  HC_UC_SHIP_METHOD: z.string().default('STD'),
  HC_UC_CURRENCY: z.string().default('AED'),
  HC_UC_FACILITY: z.string().default(''),
  // {"LAND02600683":"UC-SKU"} — empty = use HC SKU as UC SKU
  HC_SKU_MAP_JSON: z.string().default(''),
  // UI default region: india | gcc
  SCM_DEFAULT_REGION: z.string().default('india'),

  // Alerting. LOG_LEVEL is intentionally NOT here - the logger reads it straight from
  // the environment to stay dependency-free (see logger.js).
  SLACK_WEBHOOK_URL: z.string().default(''),

  // Machine auth for Cursor / Slack ops agents (no Google SSO). Empty = /api/ops/* disabled.
  // Set the same value on the VM (.env) and in Cursor Automation secrets as OPS_AGENT_TOKEN.
  OPS_AGENT_TOKEN: z.string().default(''),
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
