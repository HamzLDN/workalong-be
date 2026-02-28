/**
 * Clear all hours for the current month for hamchenhbf3@gmail.com (user_id=1).
 * Deletes time_entries and resets shift clock/approval data for a fresh start.
 */
import { pool } from '../lib/db.js';

const email = 'hamchenhbf3@gmail.com';
const now = new Date();
const startStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
const endStr = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
if (userRes.rows.length === 0) {
  console.log('User not found:', email);
  process.exit(1);
}
const userId = userRes.rows[0].id;

console.log('Clearing hours for', email, '(user_id=' + userId + ')');
console.log('Month:', startStr, 'to', endStr);

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // 1. Delete time_entries for this month
  const delTe = await client.query(
    `DELETE FROM time_entries WHERE user_id = $1 AND date >= $2 AND date <= $3 RETURNING id`,
    [userId, startStr, endStr]
  );
  console.log('Deleted', delTe.rowCount, 'time_entries');

  // 2. Reset shifts: clear clock data and approval for this month
  const updShifts = await client.query(
    `UPDATE shifts
     SET clocked_in_time = NULL, clocked_out_time = NULL,
         approved_at = NULL, approved_by = NULL,
         status = CASE WHEN status IN ('approved', 'review_hours', 'completed') THEN 'scheduled' ELSE status END,
         updated_at = NOW()
     WHERE user_id = $1 AND shift_date >= $2 AND shift_date <= $3
     RETURNING id`,
    [userId, startStr, endStr]
  );
  console.log('Reset', updShifts.rowCount, 'shifts (cleared clock/approval)');

  await client.query('COMMIT');
  console.log('\nDone. Month cleared. You can start fresh.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  client.release();
  process.exit(0);
}
