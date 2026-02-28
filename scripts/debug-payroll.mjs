import { pool } from '../lib/db.js';

const now = new Date();
const startStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
const endStr = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

console.log('=== DATABASE & PAYROLL DEBUG ===\n');
console.log('Current month:', startStr, 'to', endStr);

const db = await pool.query('SELECT current_database(), current_user');
console.log('Connected DB:', db.rows[0].current_database, 'as', db.rows[0].current_user);

// All time_entries this month
const teAll = await pool.query(`
  SELECT te.id, te.user_id, te.staff_id, te.date, te.entry_type, te.clock_in_time, te.clock_out_time, 
         te.hours_worked, te.approved_at, te.shift_id,
         s.name as staff_name, sh.clock_source
  FROM time_entries te
  JOIN staff s ON s.id = te.staff_id
  LEFT JOIN shifts sh ON sh.id = te.shift_id
  WHERE te.date >= $1 AND te.date <= $2
  ORDER BY te.user_id, te.date, te.clock_in_time
`, [startStr, endStr]);
console.log('\n--- All time_entries this month ---');
teAll.rows.forEach(r => {
  const hasClock = r.clock_in_time && r.clock_out_time;
  const approved = !!r.approved_at;
  const raw = hasClock ? `clock_in=${String(r.clock_in_time).slice(11,16)} clock_out=${String(r.clock_out_time).slice(11,16)}` : 'no clock';
  console.log(`  id=${r.id} user=${r.user_id} staff=${r.staff_name} date=${r.date} entry_type=${r.entry_type} approved=${approved} shift_id=${r.shift_id} clock_source=${r.clock_source} ${raw} hours=${r.hours_worked}`);
});

// EXACT payroll query from getStaffStats (user 1) - clock_in_out + approved_shift
console.log('\n--- Payroll calculation (user 1) - EXACT getStaffStats query (clock_in_out + approved_shift) ---');
const payroll = await pool.query(`
  WITH from_clocked AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0) as raw_hours
    FROM time_entries te
    LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = 1 AND te.date >= $1 AND te.date <= $2
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
      AND te.shift_id IS NOT NULL
    GROUP BY te.staff_id, te.date, te.shift_id, s.hours
  ),
  from_approved_shift AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric as raw_hours
    FROM time_entries te
    LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = 1 AND te.date >= $1 AND te.date <= $2
      AND te.entry_type = 'approved_shift' AND te.shift_id IS NOT NULL
  ),
  combined AS (
    SELECT staff_id, date, shift_id, shift_hours, raw_hours FROM from_clocked
    UNION ALL
    SELECT staff_id, date, shift_id, shift_hours, raw_hours FROM from_approved_shift
  )
  SELECT c.*, st.name, st.hourly_rate, LEAST(c.raw_hours, c.shift_hours)::numeric as hours_capped, (LEAST(c.raw_hours, c.shift_hours) * st.hourly_rate)::numeric as line_cost
  FROM combined c
  JOIN staff st ON st.id = c.staff_id
  WHERE st.user_id = 1
`, [startStr, endStr]);
console.log('Rows included in payroll:');
payroll.rows.forEach(r => console.log(`  staff=${r.name} date=${r.date} raw_hours=${r.raw_hours} hours_capped=${r.hours_capped} rate=${r.hourly_rate} cost=£${r.line_cost}`));

const total = await pool.query(`
  WITH from_clocked AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0) as raw_hours
    FROM time_entries te
    LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = 1 AND te.date >= $1 AND te.date <= $2
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
      AND te.shift_id IS NOT NULL
    GROUP BY te.staff_id, te.date, te.shift_id, s.hours
  ),
  from_approved_shift AS (
    SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
           COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric as raw_hours
    FROM time_entries te
    LEFT JOIN shifts s ON s.id = te.shift_id
    WHERE te.user_id = 1 AND te.date >= $1 AND te.date <= $2
      AND te.entry_type = 'approved_shift' AND te.shift_id IS NOT NULL
  ),
  combined AS (
    SELECT staff_id, date, shift_id, shift_hours, raw_hours FROM from_clocked
    UNION ALL
    SELECT staff_id, date, shift_id, shift_hours, raw_hours FROM from_approved_shift
  )
  SELECT COALESCE(SUM(LEAST(raw_hours, shift_hours) * st.hourly_rate), 0)::numeric(12,2) as total_cost,
         COALESCE(SUM(LEAST(raw_hours, shift_hours)), 0)::numeric(10,2) as total_hours
  FROM combined c
  JOIN staff st ON st.id = c.staff_id
  WHERE st.user_id = 1
`, [startStr, endStr]);
console.log('\nResult: monthlyPayroll = £' + total.rows[0].total_cost + ', hoursThisMonth = ' + total.rows[0].total_hours);

// What's EXCLUDED and why?
const excluded = await pool.query(`
  SELECT te.id, te.staff_id, te.date, te.entry_type, te.approved_at, te.shift_id, te.clock_in_time, te.clock_out_time,
         s.name, sh.clock_source
  FROM time_entries te
  JOIN staff s ON s.id = te.staff_id
  LEFT JOIN shifts sh ON sh.id = te.shift_id
  WHERE te.user_id = 1 AND te.date >= $1 AND te.date <= $2
    AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
`, [startStr, endStr]);
console.log('\n--- Time entries that COULD count (have clock times, user 1) ---');
excluded.rows.forEach(r => {
  const hasClock = true;
  const approved = !!r.approved_at;
  const entryOk = r.entry_type === 'clock_in_out';
  const shiftOk = r.shift_id != null;
  const inPayroll = approved && entryOk && shiftOk;
  console.log(`  id=${r.id} ${r.name} date=${r.date} entry_type=${r.entry_type} approved=${approved} shift_id=${r.shift_id} clock_source=${r.clock_source} IN_PAYROLL=${inPayroll}`);
});

process.exit(0);
