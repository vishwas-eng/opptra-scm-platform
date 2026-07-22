// memoStep(reqId, name, fn): run fn once per (reqId, name); on any later call return
// the stored result instead of re-running. This is the durable idempotency guarantee
// for multi-step automations — a retried run resumes and never repeats a side effect.
import { query } from './db.js';

export async function memoStep(reqId, name, fn) {
  const existing = await query('SELECT result FROM step_ledger WHERE req_id = $1 AND step = $2', [reqId, name]);
  if (existing.rowCount) return existing.rows[0].result;
  const out = await fn();
  const value = out === undefined ? null : out;
  // ON CONFLICT DO NOTHING makes a concurrent double-run safe; then read the winner.
  await query(
    'INSERT INTO step_ledger (req_id, step, result) VALUES ($1, $2, $3) ON CONFLICT (req_id, step) DO NOTHING',
    [reqId, name, JSON.stringify(value)]);
  const row = await query('SELECT result FROM step_ledger WHERE req_id = $1 AND step = $2', [reqId, name]);
  return row.rows[0].result;
}

// Test/DI seam: build a memoStep bound to an injected store (used in unit tests).
export function makeMemoStep(store) {
  return async function memoStepWith(reqId, name, fn) {
    const key = `${reqId}::${name}`;
    if (store.has(key)) return store.get(key);
    const out = await fn();
    store.set(key, out === undefined ? null : out);
    return store.get(key);
  };
}
