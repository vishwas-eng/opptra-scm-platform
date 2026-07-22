-- Idempotency ledger for multi-step automations (inward/outward/full-cycle). Each step
-- of a reqId memoizes its result; a retry resumes where it left off and NEVER
-- double-creates a PO / double-invoices / double-adds stock. Ported from the Apps
-- Script step_() memo (which used Script Properties) to durable Postgres.
CREATE TABLE step_ledger (
  req_id   text NOT NULL,
  step     text NOT NULL,
  result   jsonb,
  done_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (req_id, step)
);
