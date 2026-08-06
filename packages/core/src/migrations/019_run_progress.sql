-- Live progress for a running job.
--
-- Operators watching a sync had no idea what it was doing: the screen said "Working"
-- for a minute and then "Succeeded", which for a dry run meant nothing had changed and
-- looked identical to a real upload. Steps are written as the job goes so the UI can
-- show "Downloading the seller list", "Reading stock from Unicommerce", and so on.
--
-- Kept on the run row rather than in a separate table: it is read exactly when the run
-- is read, it is small, and it disappears with the run it belongs to.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '[]'::jsonb;
