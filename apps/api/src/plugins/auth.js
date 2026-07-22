// Human authentication: Google Sign-In (ID token) → verified against GOOGLE_CLIENT_ID,
// restricted to ALLOWED_DOMAIN → httpOnly signed JWT cookie. RBAC via users table.
import fp from 'fastify-plugin';
import { OAuth2Client } from 'google-auth-library';
import { config, query, audit, logger } from '@opptra/core';

export default fp(async function authPlugin(app) {
  const cfg = config();
  const google = new OAuth2Client(cfg.GOOGLE_CLIENT_ID);

  await app.register(import('@fastify/cookie'));
  await app.register(import('@fastify/jwt'), {
    secret: cfg.JWT_SECRET,
    cookie: { cookieName: 'opptra_session', signed: false },
    sign: { expiresIn: `${cfg.SESSION_TTL_HOURS}h` },
  });

  // POST /auth/google  { credential }  → session cookie
  app.post('/auth/google', {
    schema: {
      body: { type: 'object', required: ['credential'], properties: { credential: { type: 'string', minLength: 20 } } },
    },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    let payload;
    try {
      const ticket = await google.verifyIdToken({ idToken: req.body.credential, audience: cfg.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (err) {
      logger.warn({ err: String(err) }, 'google token verification failed');
      return reply.code(401).send({ error: 'invalid Google token' });
    }
    const email = String(payload.email || '').toLowerCase();
    const domainOk = payload.email_verified && (payload.hd === cfg.ALLOWED_DOMAIN || email.endsWith('@' + cfg.ALLOWED_DOMAIN));
    if (!domainOk) {
      await audit(email || 'unknown', 'login-rejected', { reason: 'domain', hd: payload.hd });
      return reply.code(403).send({ error: `only @${cfg.ALLOWED_DOMAIN} accounts are allowed` });
    }

    const isBootstrapAdmin = cfg.adminEmails.includes(email);
    const { rows } = await query(
      `INSERT INTO users (email, name, picture, role, last_login)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name, picture = EXCLUDED.picture, last_login = now(),
         role = CASE WHEN $5 THEN 'admin' ELSE users.role END
       RETURNING email, name, picture, role, is_active`,
      [email, payload.name || '', payload.picture || '', isBootstrapAdmin ? 'admin' : 'ops', isBootstrapAdmin]
    );
    const user = rows[0];
    if (!user.is_active) {
      await audit(email, 'login-rejected', { reason: 'deactivated' });
      return reply.code(403).send({ error: 'account deactivated — contact an admin' });
    }

    const token = await reply.jwtSign({ email: user.email, name: user.name, role: user.role });
    await audit(email, 'login', {});
    return reply
      .setCookie('opptra_session', token, {
        path: '/', httpOnly: true, sameSite: 'lax', secure: cfg.isProd,
        maxAge: cfg.SESSION_TTL_HOURS * 3600,
      })
      .send({ user: { email: user.email, name: user.name, picture: user.picture, role: user.role } });
  });

  app.post('/auth/logout', async (req, reply) => {
    return reply.clearCookie('opptra_session', { path: '/' }).send({ ok: true });
  });

  // Decorators used by every protected route.
  app.decorate('requireUser', async function (req, reply) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'not signed in' });
    }
  });

  app.decorate('requireRole', (...roles) => async function (req, reply) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'not signed in' });
    }
    if (!roles.includes(req.user.role)) {
      return reply.code(403).send({ error: `requires role: ${roles.join(' or ')}` });
    }
  });
});
