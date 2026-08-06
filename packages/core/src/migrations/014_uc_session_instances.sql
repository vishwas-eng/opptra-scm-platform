-- Multi-instance Unicommerce session vault.
-- Each UC tenant (india prod / UAE / staging) has its own JSESSIONID.
-- Logging into one must never overwrite another.
--
-- Migrates the legacy singleton (id=1) → instance_id='india', then seeds
-- empty rows for 'uae' and 'staging'. Idempotent.

ALTER TABLE uc_session ADD COLUMN IF NOT EXISTS instance_id text;
ALTER TABLE uc_session ADD COLUMN IF NOT EXISTS base_url text NOT NULL DEFAULT '';

-- Legacy singleton used CHECK (id = 1). Drop those before changing the PK.
ALTER TABLE uc_session DROP CONSTRAINT IF EXISTS uc_session_pkey;
ALTER TABLE uc_session DROP CONSTRAINT IF EXISTS uc_session_id_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'uc_session' AND column_name = 'id'
  ) THEN
    UPDATE uc_session
       SET instance_id = COALESCE(NULLIF(instance_id, ''), 'india'),
           base_url = CASE
             WHEN COALESCE(base_url, '') = '' THEN 'https://oppdoor.unicommerce.co.in'
             ELSE base_url
           END
     WHERE id = 1;
  ELSE
    UPDATE uc_session
       SET instance_id = COALESCE(NULLIF(instance_id, ''), 'india')
     WHERE instance_id IS NULL OR instance_id = '';
  END IF;
END $$;

ALTER TABLE uc_session ALTER COLUMN instance_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'uc_session' AND column_name = 'id'
  ) THEN
    ALTER TABLE uc_session DROP COLUMN id;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uc_session_pkey'
  ) THEN
    ALTER TABLE uc_session ADD PRIMARY KEY (instance_id);
  END IF;
END $$;

INSERT INTO uc_session (instance_id, base_url, source, status)
VALUES
  ('india', 'https://oppdoor.unicommerce.co.in', 'none', 'unknown'),
  ('uae', 'https://opptrauae.unicommerce.com', 'none', 'unknown'),
  ('ksa', 'https://opptraksa.unicommerce.com', 'none', 'unknown'),
  ('staging', 'https://oppdoorstg.unicommerce.com', 'none', 'unknown')
ON CONFLICT (instance_id) DO NOTHING;

-- Ensure india base_url is set if the migrated row had an empty one.
UPDATE uc_session
   SET base_url = 'https://oppdoor.unicommerce.co.in'
 WHERE instance_id = 'india' AND (base_url IS NULL OR base_url = '');
