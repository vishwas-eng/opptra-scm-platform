-- Remember the Gmail thread each warehouse's packing email lives in, so the labels /
-- appointment-letter follow-up can land in the SAME thread later that day (Gmail's
-- thread search would need an extra OAuth scope; recording our own threads doesn't).
CREATE TABLE packing_threads (
  id         bigserial PRIMARY KEY,
  warehouse  text NOT NULL,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  thread_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX packing_threads_wh_idx ON packing_threads (warehouse, created_at DESC);
