import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sealSecret, openSecret, isSealed, _resetSecretBoxForTests } from '../src/secretBox.js';
import { _resetConfigForTests } from '../src/config.js';

// config() validates the whole environment on first use; satisfy the required keys.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://opptra:localdev@127.0.0.1:5432/opptra_test';
process.env.UC_BASE_URL = process.env.UC_BASE_URL || 'https://example.unicommerce.invalid';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-32-chars-long!!';

function resetKey() {
  _resetConfigForTests();
  _resetSecretBoxForTests();
}

beforeEach(() => {
  delete process.env.VAULT_KEY;
  resetKey();
});

test('seal → open round-trips arbitrary secrets', () => {
  for (const s of ['JSESSIONID-style-cookie', 'Atzr|refresh-token', 'p@ss w0rd\nwith newline', '™ unicode ✓']) {
    const sealed = sealSecret(s);
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes(s.slice(0, 8)), 'ciphertext must not contain plaintext');
    assert.equal(openSecret(sealed), s);
  }
});

test('empty stays empty — rows use "" as "no secret"', () => {
  assert.equal(sealSecret(''), '');
  assert.equal(sealSecret(null), '');
  assert.equal(openSecret(''), '');
});

test('legacy plaintext passes through openSecret unchanged', () => {
  assert.equal(openSecret('plain-old-cookie-value'), 'plain-old-cookie-value');
  assert.equal(isSealed('plain-old-cookie-value'), false);
});

test('two seals of the same secret differ (fresh IV) but both open', () => {
  const a = sealSecret('same');
  const b = sealSecret('same');
  assert.notEqual(a, b);
  assert.equal(openSecret(a), 'same');
  assert.equal(openSecret(b), 'same');
});

test('tampered ciphertext throws instead of returning garbage', () => {
  const sealed = sealSecret('do-not-corrupt-me');
  const buf = Buffer.from(sealed.slice('enc:v1:'.length), 'base64');
  buf[buf.length - 1] ^= 0xff;
  const tampered = 'enc:v1:' + buf.toString('base64');
  assert.throws(() => openSecret(tampered), /failed to open/);
});

test('truncated sealed value throws', () => {
  assert.throws(() => openSecret('enc:v1:AAAA'), /truncated/);
});

test('explicit VAULT_KEY (base64 and hex) is honored and validated', () => {
  process.env.VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  resetKey();
  const sealed = sealSecret('with-explicit-key');
  assert.equal(openSecret(sealed), 'with-explicit-key');

  // The JWT-derived key must NOT open a VAULT_KEY-sealed row: silently falling back
  // would mask a key mix-up between environments.
  delete process.env.VAULT_KEY;
  resetKey();
  assert.throws(() => openSecret(sealed), /failed to open/);

  process.env.VAULT_KEY = 'ff'.repeat(32); // hex form
  resetKey();
  assert.equal(openSecret(sealSecret('hex-key')), 'hex-key');

  process.env.VAULT_KEY = 'too-short';
  resetKey();
  assert.throws(() => sealSecret('x'), /32 bytes/);
});
