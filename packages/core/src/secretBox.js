// Encryption-at-rest for stored credentials (connector vault, UC session cookies,
// OAuth refresh tokens). AES-256-GCM, one key per deployment.
//
// Storage format: `enc:v1:<base64(iv || authTag || ciphertext)>`. The prefix makes
// sealed values self-describing, so openSecret() can pass legacy plaintext rows
// through unchanged and sealPlaintextAtRest() can find-and-seal them at boot, // no flag column, no big-bang migration, rollback-safe.
//
// Key resolution (checked once, cached):
//   1. VAULT_KEY env, 32 bytes as base64 or hex. Set this in production so the
//      data-encryption key can rotate independently of JWT signing.
//   2. Derived from JWT_SECRET via scrypt with a fixed app salt. Means encryption
//      is ALWAYS on, a deploy that never set VAULT_KEY still never writes
//      plaintext to disk. Rotating JWT_SECRET without VAULT_KEY set will orphan
//      sealed rows (operators re-paste sessions), which is the documented trade.
import crypto from 'node:crypto';
import { config } from './config.js';

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT_SALT = 'opptra-scm-secretbox-v1';

let cachedKey = null;

function parseExplicitKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b64 = Buffer.from(s, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('VAULT_KEY must be 32 bytes, base64- or hex-encoded');
}

function key() {
  if (cachedKey) return cachedKey;
  const cfg = config();
  cachedKey = parseExplicitKey(cfg.VAULT_KEY)
    || crypto.scryptSync(cfg.JWT_SECRET, SCRYPT_SALT, 32);
  return cachedKey;
}

/** True when the stored value is already sealed. */
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Seal a secret for storage. Empty input stays empty (rows use '' as "no secret"). */
export function sealSecret(plaintext) {
  const s = String(plaintext ?? '');
  if (!s) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/**
 * Open a stored secret. Legacy plaintext (no prefix) passes through unchanged.
 * A sealed value that fails to open (wrong/rotated key, corrupt row) throws, * silently returning ciphertext would send garbage to a vendor as a credential.
 */
export function openSecret(stored) {
  const s = String(stored ?? '');
  if (!isSealed(s)) return s;
  const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('sealed secret is truncated');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('sealed secret failed to open, VAULT_KEY/JWT_SECRET changed since it was stored');
  }
}

/** Test helper, forget the cached key so a test can vary config. */
export function _resetSecretBoxForTests() {
  cachedKey = null;
}
