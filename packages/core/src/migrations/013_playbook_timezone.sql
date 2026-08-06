-- Daily playbooks could only fire on a whole UTC hour, so "every day 9:00 IST" — the
-- literal thing ops ask for — was unrepresentable (IST is UTC+5:30, i.e. 03:30 UTC).
-- Store the wall-clock time the operator picked plus its IANA zone, and let BullMQ's
-- scheduler do the conversion (cron pattern + tz).
--
-- Back-compat: existing rows keep hour_utc, gain minute 0 and zone UTC, so their next
-- fire time is byte-identical to before this migration.
ALTER TABLE agent_playbooks
  ADD COLUMN IF NOT EXISTS schedule_minute int NOT NULL DEFAULT 0
    CHECK (schedule_minute >= 0 AND schedule_minute <= 59),
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
