// Admin-only: session cookie paste (the bridge until scripted login), user management.
import { query, audit } from '@opptra/core';

export default async function adminRoutes(app) {
  const adminOnly = { preHandler: app.requireRole('admin') };

  // Paste a fresh JSESSIONID captured from the browser. Stored in Postgres; the worker
  // picks it up on its next call (it re-reads on session death and on keepalive).
  app.post('/api/admin/uc-session', {
    ...adminOnly,
    schema: {
      body: {
        type: 'object', required: ['jsessionid'],
        properties: { jsessionid: { type: 'string', minLength: 8, maxLength: 512 } },
      },
    },
  }, async (req) => {
    const cookie = req.body.jsessionid.trim().replace(/^JSESSIONID=/i, '');
    await query(
      `UPDATE uc_session SET jsessionid = $1, source = 'admin-paste', status = 'unknown',
        updated_by = $2, updated_at = now(), fail_count = 0 WHERE id = 1`,
      [cookie, req.user.email]
    );
    await audit(req.user.email, 'uc-session-paste', {});
    return { ok: true };
  });

  app.get('/api/admin/users', adminOnly, async () => {
    const { rows } = await query(
      'SELECT email, name, role, is_active, created_at, last_login FROM users ORDER BY created_at');
    return { users: rows };
  });

  app.post('/api/admin/users/:email', {
    ...adminOnly,
    schema: {
      params: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['admin', 'ops', 'viewer'] },
          is_active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const email = req.params.email.toLowerCase();
    if (email === req.user.email && req.body.is_active === false) {
      return reply.code(400).send({ error: 'cannot deactivate yourself' });
    }
    const sets = [];
    const params = [];
    if (req.body.role) { params.push(req.body.role); sets.push(`role = $${params.length}`); }
    if (typeof req.body.is_active === 'boolean') { params.push(req.body.is_active); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing to update' });
    params.push(email);
    const { rowCount } = await query(`UPDATE users SET ${sets.join(', ')} WHERE email = $${params.length}`, params);
    if (!rowCount) return reply.code(404).send({ error: 'user not found' });
    await audit(req.user.email, 'user-update', { target: email, ...req.body });
    return { ok: true };
  });

  app.get('/api/admin/audit', adminOnly, async () => {
    const { rows } = await query('SELECT at, actor, event, detail FROM audit_log ORDER BY at DESC LIMIT 200');
    return { audit: rows };
  });
}
