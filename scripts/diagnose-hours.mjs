import { pool } from '../lib/db.js';

const now = new Date();
const startStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
const endStr = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
const userId = 1;

// 1. Breakdown by entry_type for user 1
const byType = await pool.query(`
  SELECT te.entry_type, te.shift_id IS NOT NULL as has_shift,
         COUNT(*)::int as cnt,
         COALESCE(SUM(COALESCE(te.hours_worked,0) + COALESCE(te.overtime_hours,0)), 0)::numeric(10,2) as sum_hours
  FROM time_entries te
  WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
  GROUP BY te.entry_type, (te.shift_id IS NOT NULL)
`, [userId, startStr, endStr]);
console.log('=== HOURS ACCURACY DIAGNOSIS (user 1, month:', startStr, 'to', endStr, ') ===\n');
console.log('1. By entry_type (has_shift = has shift_id):');
byType.rows.forEach(r => console.log(' ', r.entry_type, 'has_shift=' + r.has_shift, 'cnt=' + r.cnt, 'sum_hours=' + r.sum_hours));

// 2. Hours BEFORE vs AFTER LEAST cap (what we use now)
const cap = await pool.query(`
  WITH from_clocked AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0) as raw_hours
    FROM time_entries te LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL AND te.shift_id IS NOT NULL
    GROUP BY te.staff_id, te.date, te.shift_id, s.hours
  ),
  from_approved AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric as raw_hours
    FROM time_entries te LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
      AND te.entry_type = 'approved_shift' AND te.shift_id IS NOT NULL
  ),
  combined AS (
    SELECT raw_hours, shift_hours, LEAST(raw_hours, shift_hours) as capped
    FROM (SELECT * FROM from_clocked UNION ALL SELECT * FROM from_approved) x
  )
  SELECT SUM(raw_hours)::numeric(10,2) as total_raw, SUM(capped)::numeric(10,2) as total_capped,
         (SUM(raw_hours) - SUM(capped))::numeric(10,2) as lost_to_cap
  FROM combined
`, [userId, startStr, endStr]);
console.log('\n2. LEAST(raw_hours, shift_hours) cap effect:');
console.log('   total_raw (actual hours worked)=', cap.rows[0].total_raw);
console.log('   total_capped (what we show)    =', cap.rows[0].total_capped);
console.log('   LOST to cap (overtime etc)     =', cap.rows[0].lost_to_cap);

// 3. approved_shift with shift_id=null (EXCLUDED)
const excludedApproved = await pool.query(`
  SELECT COUNT(*)::int as cnt, COALESCE(SUM(hours_worked + COALESCE(overtime_hours,0)), 0)::numeric(10,2) as hours
  FROM time_entries
  WHERE user_id = $1 AND date >= $2 AND date <= $3
    AND entry_type = 'approved_shift' AND shift_id IS NULL
`, [userId, startStr, endStr]);
console.log('\n3. approved_shift with shift_id=null (EXCLUDED from our query):');
console.log('   cnt=', excludedApproved.rows[0].cnt, 'hours=', excludedApproved.rows[0].hours);

// 4. manual entries (EXCLUDED)
const manual = await pool.query(`
  SELECT COUNT(*)::int as cnt, COALESCE(SUM(hours_worked + COALESCE(overtime_hours,0)), 0)::numeric(10,2) as hours
  FROM time_entries
  WHERE user_id = $1 AND date >= $2 AND date <= $3 AND entry_type = 'manual'
`, [userId, startStr, endStr]);
console.log('\n4. manual entries (EXCLUDED from our query):');
console.log('   cnt=', manual.rows[0].cnt, 'hours=', manual.rows[0].hours);

// 5. What "actual hours" would be if we included everything and did NOT cap
const actualAll = await pool.query(`
  SELECT 
    COALESCE(SUM(CASE WHEN te.entry_type = 'clock_in_out' AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      THEN EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0 ELSE 0 END), 0)::numeric(10,2) as from_clock,
    COALESCE(SUM(CASE WHEN te.entry_type = 'approved_shift'
      THEN COALESCE(te.hours_worked,0) + COALESCE(te.overtime_hours,0) ELSE 0 END), 0)::numeric(10,2) as from_approved,
    COALESCE(SUM(CASE WHEN te.entry_type = 'manual'
      THEN COALESCE(te.hours_worked,0) + COALESCE(te.overtime_hours,0) ELSE 0 END), 0)::numeric(10,2) as from_manual
  FROM time_entries te
  WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
`, [userId, startStr, endStr]);
const r = actualAll.rows[0];
const totalActual = parseFloat(r.from_clock) + parseFloat(r.from_approved) + parseFloat(r.from_manual);
console.log('\n5. ACTUAL hours if we count ALL entries (no cap, no shift_id filter):');
console.log('   from_clock_in_out  =', r.from_clock);
console.log('   from_approved_shift=', r.from_approved);
console.log('   from_manual       =', r.from_manual);
console.log('   TOTAL ACTUAL      =', totalActual.toFixed(2));

process.exit(0);
