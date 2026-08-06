import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userBucket, perUser } from '../src/plugins/rateLimitKey.js';

const req = (cookie, ip = '10.0.0.1') => ({ headers: cookie ? { cookie } : {}, ip });

function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.notasignature`;
}

test('signed-in users get a stable per-user bucket', () => {
  const c = `opptra_session=${fakeJwt({ email: 'ops@opptra.com' })}`;
  assert.equal(userBucket(req(c)), '10.0.0.1|u:ops@opptra.com');
  assert.equal(userBucket(req(c)), userBucket(req(c)), 'bucket must be stable');
});

test('emails are lowercased so casing cannot split a bucket', () => {
  const a = userBucket(req(`opptra_session=${fakeJwt({ email: 'Ops@Opptra.com' })}`));
  const b = userBucket(req(`opptra_session=${fakeJwt({ email: 'ops@opptra.com' })}`));
  assert.equal(a, b);
});

test('SECURITY: a forged email cannot escape its source IP bucket prefix', () => {
  // The cookie payload is attacker-controlled (signature is not checked here), so a
  // forged claim must only ever split THAT IP's traffic, never mint IP-free buckets.
  const forged = userBucket(req(`opptra_session=${fakeJwt({ email: 'made-up@evil.test' })}`, '203.0.113.9'));
  const anon = userBucket(req(null, '203.0.113.9'));
  assert.ok(forged.startsWith('203.0.113.9|'));
  assert.ok(anon.startsWith('203.0.113.9|'));
});

test('oversized forged claims are truncated so the limiter key store cannot be bloated', () => {
  const huge = `${'a'.repeat(5000)}@opptra.com`;
  const key = userBucket(req(`opptra_session=${fakeJwt({ email: huge })}`));
  assert.ok(key.length < 200, `key was ${key.length} chars`);
});

test('malformed / missing / non-JSON cookies fall back to the anon IP bucket', () => {
  assert.equal(userBucket(req(null)), '10.0.0.1|anon');
  assert.equal(userBucket(req('opptra_session=garbage')), '10.0.0.1|anon');
  assert.equal(userBucket(req('opptra_session=a.!!!notbase64!!!.c')), '10.0.0.1|anon');
  assert.equal(userBucket(req('other=1')), '10.0.0.1|anon');
});

test('perUser produces a fastify rate-limit route config', () => {
  const cfg = perUser(30, '1 minute');
  assert.equal(cfg.rateLimit.max, 30);
  assert.equal(cfg.rateLimit.timeWindow, '1 minute');
  assert.equal(cfg.rateLimit.keyGenerator, userBucket);
});
