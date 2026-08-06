-- Relay jobs: work that must run on a machine inside a network the platform cannot
-- reach (today: 6th Street's IBM Sterling OMS behind a Forti VPN whose gateway is a
-- private address).
--
-- The platform never dials in. An agent on an already-connected machine polls
-- outbound over HTTPS, claims a job, does the fetch through the tunnel it already has,
-- and posts the artifacts back. No inbound firewall rule, no site-to-site, and it works
-- regardless of MFA or split-tunnel because a human already authenticated.

CREATE TABLE relay_jobs (
  id            bigserial PRIMARY KEY,
  job_uid       text NOT NULL UNIQUE,
  connector_id  text NOT NULL,              -- '6thstreet'
  kind          text NOT NULL,              -- 'oms.packDocs'
  status        text NOT NULL DEFAULT 'pending', -- pending|claimed|done|failed|expired
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- what to fetch (order ids…)
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- metadata only; files go to artifacts
  artifacts     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, contentType, size, base64}]
  error         text NOT NULL DEFAULT '',
  requested_by  text NOT NULL DEFAULT '',
  claimed_by    text NOT NULL DEFAULT '',   -- agent id, for "who fetched this"
  -- A claim that is never completed (laptop slept, VPN dropped) must not strand the
  -- job forever; the claim expires and another agent can take it.
  claim_expires_at timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX relay_jobs_queue_idx ON relay_jobs (connector_id, status, created_at);
CREATE INDEX relay_jobs_uid_idx ON relay_jobs (job_uid);
