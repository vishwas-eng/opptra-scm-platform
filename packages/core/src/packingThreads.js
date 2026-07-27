// Thread memory for packing mail follow-ups (see migrations 005 + 006).
// Scoped by user_email so each operator's invoice/e-way draft joins THEIR Gmail thread.
import { query } from './db.js';

export async function savePackingThread({ warehouse, toEmail, subject, threadId, userEmail = '' }) {
  if (!threadId) return;
  await query(
    'INSERT INTO packing_threads (warehouse, to_email, subject, thread_id, user_email) VALUES ($1, $2, $3, $4, $5)',
    [warehouse, toEmail, subject, threadId, String(userEmail || '').trim().toLowerCase()],
  );
}

/** Latest thread for a warehouse (and user, when provided). */
export async function latestPackingThread(warehouse, userEmail = '') {
  const email = String(userEmail || '').trim().toLowerCase();
  if (email) {
    const { rows } = await query(
      `SELECT to_email, subject, thread_id, user_email FROM packing_threads
       WHERE warehouse = $1 AND user_email = $2 ORDER BY created_at DESC LIMIT 1`,
      [warehouse, email],
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `SELECT to_email, subject, thread_id, user_email FROM packing_threads
     WHERE warehouse = $1 ORDER BY created_at DESC LIMIT 1`, [warehouse]);
  return rows[0] || null;
}
