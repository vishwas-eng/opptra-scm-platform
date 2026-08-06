-- Per-channel, per-region operation schedules, owned by operators rather than by env.
--
-- Cadence used to live in env vars (HC_SYNC_MINUTES, STREET6_SYNC_MINUTES), which meant
-- changing when a sync runs required a redeploy, applied globally, and could not differ
-- between UAE and KSA. This table makes the schedule a first-class object: one row per
-- (connector, region, operation), edited in the UI, picked up by the worker.

CREATE TABLE channel_schedules (
  id            bigserial PRIMARY KEY,
  connector_id  text NOT NULL,               -- 'homecentre' | '6thstreet'
  region        text NOT NULL DEFAULT '',    -- 'uae' | 'ksa' | '' when the channel has one
  operation     text NOT NULL,               -- 'inventory' | 'orders'
  enabled       boolean NOT NULL DEFAULT false,
  -- Wall-clock time in `timezone`, NOT UTC. GST/AST are whole-hour offsets but IST is
  -- +5:30, so a UTC-hour-only cron cannot express "09:00 local" everywhere. BullMQ
  -- converts using the zone.
  hour          int NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  minute        int NOT NULL DEFAULT 0 CHECK (minute IN (0, 15, 30, 45)),
  timezone      text NOT NULL DEFAULT 'Asia/Dubai',
  -- Scheduled runs default to dry-run: a schedule that starts writing to a live
  -- marketplace the moment someone saves it is not a safe default.
  dry_run       boolean NOT NULL DEFAULT true,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per-operation extras (source, limit…)
  owner_email   text NOT NULL DEFAULT '',
  last_run_at   timestamptz,
  last_status   text NOT NULL DEFAULT '',
  last_error    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, region, operation)
);

CREATE INDEX channel_schedules_enabled_idx ON channel_schedules (enabled, connector_id);
