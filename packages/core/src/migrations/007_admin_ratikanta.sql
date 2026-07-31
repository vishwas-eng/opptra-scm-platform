-- Durable bootstrap: grant full admin to ratikanta@opptra.com.
-- Survives deploys even if ADMIN_EMAILS on the VM is stale; login still
-- re-asserts admin when the email is listed in ADMIN_EMAILS.
INSERT INTO users (email, name, role, is_active, last_login)
VALUES ('ratikanta@opptra.com', 'Ratikanta', 'admin', true, now())
ON CONFLICT (email) DO UPDATE SET
  role = 'admin',
  is_active = true;
