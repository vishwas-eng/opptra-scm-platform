-- Correct Unicommerce tenant hostnames (company codes from UC portal):
--   opptrauae → opptrauae.unicommerce.com  (was wrongly oppdooruae)
--   opptraksa → opptraksa.unicommerce.com  (new vault row)
-- Idempotent.

UPDATE uc_session
   SET base_url = 'https://opptrauae.unicommerce.com'
 WHERE instance_id = 'uae'
   AND (
     base_url = '' OR base_url IS NULL
     OR base_url LIKE '%oppdooruae%'
   );

INSERT INTO uc_session (instance_id, base_url, source, status)
VALUES ('ksa', 'https://opptraksa.unicommerce.com', 'none', 'unknown')
ON CONFLICT (instance_id) DO UPDATE SET
  base_url = CASE
    WHEN uc_session.base_url = '' OR uc_session.base_url IS NULL
      OR uc_session.base_url LIKE '%oppdoorsa%'
      OR uc_session.base_url LIKE '%oppdoorksa%'
      OR uc_session.base_url LIKE '%oppdoorsaudi%'
    THEN EXCLUDED.base_url
    ELSE uc_session.base_url
  END;
