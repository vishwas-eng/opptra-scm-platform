-- Users: humans signing in with their @opptra.com Google account.
CREATE TABLE users (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text NOT NULL DEFAULT '',
  picture     text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT 'ops' CHECK (role IN ('admin', 'ops', 'viewer')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

-- Runs: one row per automation action — THE attribution/audit record.
CREATE TABLE runs (
  id           bigserial PRIMARY KEY,
  run_uid      text NOT NULL UNIQUE,
  user_email   text NOT NULL,            -- 'system' for scheduled jobs
  owner_email  text NOT NULL DEFAULT '', -- who configured a scheduled job (set once the reports-digest scheduler lands)
  automation   text NOT NULL,            -- e.g. 'return', 'ewaybill', 'asn'
  action       text NOT NULL,            -- e.g. 'process-so', 'compile'
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'pending_retry', 'succeeded', 'failed', 'cancelled')),
  result       jsonb,
  error        text,
  -- Populated by file-producing automations (ASN sheets, reverse-DC PDFs) as they land.
  artifacts    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX runs_created_idx ON runs (created_at DESC);
CREATE INDEX runs_user_idx ON runs (user_email, created_at DESC);
CREATE INDEX runs_automation_idx ON runs (automation, created_at DESC);
CREATE INDEX runs_status_idx ON runs (status) WHERE status IN ('queued', 'running', 'pending_retry');

-- The single Unicommerce bot session (one whitelisted account). Singleton row id=1.
CREATE TABLE uc_session (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  jsessionid    text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'none'  -- 'none' | 'override' | 'admin-paste' | 'scripted-login'
                CHECK (source IN ('none', 'override', 'admin-paste', 'scripted-login')),
  status        text NOT NULL DEFAULT 'unknown'
                CHECK (status IN ('unknown', 'alive', 'dead')),
  facility      text NOT NULL DEFAULT '',
  updated_by    text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_ok_at    timestamptz,
  last_check_at timestamptz,
  fail_count    int NOT NULL DEFAULT 0
);
INSERT INTO uc_session (id) VALUES (1);

-- Append-only audit of security-relevant events (logins, role changes, session pastes).
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_at_idx ON audit_log (at DESC);
