/**
 * Trace hours for hamchenhbf3@gmail.com - physical count vs dashboard vs schedule
 */
import { pool } from '../lib/db.js';

const email = 'hamchenhbf3@gmail.com';
const now = new Date();
const startStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
const endStr = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

// 1. Get user
const userRes = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
if (userRes.rows.length === 0) {
  console.log('User not found:', email);
  process.exit(1);
}
const userId = userRes.rows[0].id;
console.log('=== HOURS TRACE for', email, '(user_id=' + userId + ') ===\n');
console.log('Month:', startStr, 'to', endStr);

// 2. All time_entries this month (raw)
const teRes = await pool.query(`
  SELECT te.id, te.staff_id, te.date, te.entry_type, te.clock_in_time, te.clock_out_time,
         te.hours_worked, te.overtime_hours, te.approved_at, te.shift_id, s.name as staff_name
  FROM time_entries te
  JOIN staff s ON s.id = te.staff_id
  WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
  ORDER BY te.date, te.id
`, [userId, startStr, endStr]);

console.log('\n--- ALL time_entries this month ---');
let manualSum = 0, clockSum = 0, approvedSum = 0;
teRes.rows.forEach(r => {
  const h = parseFloat(r.hours_worked || 0) + parseFloat(r.overtime_hours || 0);
  let rawHours = h;
  if (r.entry_type === 'clock_in_out' && r.clock_in_time && r.clock_out_time) {
    rawHours = (new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3600000;
  } else if (r.entry_type === 'approved_shift' || r.entry_type === 'manual') {
    rawHours = h;
  }
  if (r.entry_type === 'manual') manualSum += rawHours;
  if (r.entry_type === 'clock_in_out') clockSum += rawHours;
  if (r.entry_type === 'approved_shift') approvedSum += rawHours;
  console.log(`  id=${r.id} staff=${r.staff_name} date=${r.date} type=${r.entry_type} shift_id=${r.shift_id} approved=${!!r.approved_at} hours=${rawHours.toFixed(2)} (hours_worked=${r.hours_worked} ot=${r.overtime_hours})`);
});

console.log('\n  SUBTOTALS: clock_in_out=' + clockSum.toFixed(2) + ' approved_shift=' + approvedSum.toFixed(2) + ' manual=' + manualSum.toFixed(2));
console.log('  PHYSICAL TOTAL (all entries):', (clockSum + approvedSum + manualSum).toFixed(2));

// 3. All shifts this month
const shiftRes = await pool.query(`
  SELECT s.id, s.staff_id, s.shift_date, s.hours as scheduled_hours, s.status, s.clocked_in_time, s.clocked_out_time,
         st.name as staff_name
  FROM shifts s
  JOIN staff st ON st.id = s.staff_id
  WHERE s.user_id = $1 AND s.shift_date >= $2 AND s.shift_date <= $3
  ORDER BY s.shift_date, s.id
`, [userId, startStr, endStr]);

console.log('\n--- ALL shifts this month ---');
shiftRes.rows.forEach(r => {
  let actualFromClock = null, actualFromApproved = null;
  const clockTe = teRes.rows.filter(t => t.shift_id === r.id && t.entry_type === 'clock_in_out' && t.clock_in_time && t.clock_out_time);
  const approvedTe = teRes.rows.filter(t => t.shift_id === r.id && t.entry_type === 'approved_shift');
  if (clockTe.length) actualFromClock = clockTe.reduce((s,t) => s + ((new Date(t.clock_out_time) - new Date(t.clock_in_time)) / 3600000), 0);
  if (approvedTe.length) actualFromApproved = approvedTe.reduce((s,t) => s + parseFloat(t.hours_worked||0) + parseFloat(t.overtime_hours||0), 0);
  const actual = actualFromClock ?? actualFromApproved ?? (r.clocked_in_time && r.clocked_out_time ? (new Date(r.clocked_out_time) - new Date(r.clocked_in_time)) / 3600000 : 0);
  console.log(`  shift_id=${r.id} staff=${r.staff_name} date=${r.shift_date} status=${r.status} scheduled=${r.scheduled_hours}h actual_from_clock=${actualFromClock?.toFixed(2) ?? '-'} actual_from_approved=${actualFromApproved?.toFixed(2) ?? '-'} -> actual=${actual.toFixed(2)}h`);
});

// 4. Run getStaffStats (what dashboard shows)
const { getStaffStats } = await import('../services/staff.js');
const stats = await getStaffStats(userId);
console.log('\n--- Dashboard getStaffStats ---');
console.log('  hoursThisMonth:', stats.hoursThisMonth);
console.log('  monthlyPayroll:', stats.monthlyPayroll);
console.log('  attendanceHoursByStaff:', JSON.stringify(stats.attendanceHoursByStaff, null, 2));

// 5. Run getShifts and sum actual_hours_worked (what schedule shows)
const { getShifts } = await import('../services/shifts.js');
const shifts = await getShifts(userId, { startDate: startStr, endDate: endStr });
const scheduleSum = shifts.reduce((s, sh) => s + (parseFloat(sh.actual_hours_worked) || 0), 0);
console.log('\n--- Schedule (sum of actual_hours_worked per shift) ---');
console.log('  shifts count:', shifts.length);
console.log('  sum of actual_hours_worked:', scheduleSum.toFixed(2));
shifts.forEach(sh => console.log(`    shift ${sh.id} ${sh.staff_name} ${sh.shift_date}: scheduled=${sh.hours}h actual=${sh.actual_hours_worked}h`));

// 6. Raw SQL: what the dashboard hours query returns
const dashRes = await pool.query(`
  WITH from_clocked AS (
    SELECT te.staff_id, te.date, te.shift_id,
           SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as raw_hours
    FROM time_entries te
    WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
    GROUP BY te.staff_id, te.date, te.shift_id
  ),
  from_approved_shift AS (
    SELECT te.staff_id, te.date, te.shift_id,
           (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours
    FROM time_entries te
    WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
      AND te.entry_type = 'approved_shift'
  ),
  from_manual AS (
    SELECT te.staff_id, te.date, te.shift_id,
           (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours
    FROM time_entries te
    WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
      AND te.entry_type = 'manual'
  ),
  combined AS (
    SELECT 'clock_in_out' as src, staff_id, date, shift_id, raw_hours FROM from_clocked
    UNION ALL SELECT 'approved_shift', staff_id, date, shift_id, raw_hours FROM from_approved_shift
    UNION ALL SELECT 'manual', staff_id, date, shift_id, raw_hours FROM from_manual
  )
  SELECT src, staff_id, date, shift_id, raw_hours FROM combined ORDER BY date, staff_id
`, [userId, startStr, endStr]);

console.log('\n--- Dashboard query (combined rows) ---');
let dashTotal = 0;
dashRes.rows.forEach(r => {
  dashTotal += parseFloat(r.raw_hours);
  console.log(`  ${r.src} staff=${r.staff_id} date=${r.date} shift=${r.shift_id} raw_hours=${r.raw_hours}`);
});
console.log('  DASHBOARD QUERY TOTAL:', dashTotal.toFixed(2));

console.log('\n=== PHYSICAL COUNT (what you can verify) ===');
console.log('By staff this month:');
const staffTotals = {};
teRes.rows.forEach(r => {
  let h = 0;
  if (r.entry_type === 'clock_in_out' && r.clock_in_time && r.clock_out_time) {
    h = (new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3600000;
  } else {
    h = parseFloat(r.hours_worked || 0) + parseFloat(r.overtime_hours || 0);
  }
  staffTotals[r.staff_name] = (staffTotals[r.staff_name] || 0) + h;
});
Object.entries(staffTotals).sort().forEach(([name, hrs]) => console.log('  ' + name + ': ' + hrs.toFixed(2) + 'h'));
console.log('  ---');
console.log('  TOTAL (physical sum of all entries):', (clockSum + approvedSum + manualSum).toFixed(2));

console.log('\n=== DASHBOARD vs PHYSICAL ===');
console.log('Dashboard only counts: clock_in_out (APPROVED) + approved_shift + manual');
console.log('Excluded: clock_in_out with approved=false (' + (clockSum - dashRes.rows.filter(r=>r.src==='clock_in_out').reduce((s,r)=>s+parseFloat(r.raw_hours),0)).toFixed(2) + 'h from unapproved clock entries)');
console.log('');
console.log('Potential DUPLICATES (same staff, same date, multiple approved_shift):');
const byStaffDate = {};
teRes.rows.filter(r => r.entry_type === 'approved_shift').forEach(r => {
  const key = r.staff_name + '|' + r.date;
  if (!byStaffDate[key]) byStaffDate[key] = [];
  byStaffDate[key].push({ shift_id: r.shift_id, hours: parseFloat(r.hours_worked||0) + parseFloat(r.overtime_hours||0) });
});
Object.entries(byStaffDate).filter(([k,v]) => v.length > 1).forEach(([k, arr]) => {
  const total = arr.reduce((s,a) => s + a.hours, 0);
  console.log('  ' + k.split('|')[0] + ' on ' + k.split('|')[1] + ': ' + arr.length + ' entries = ' + total.toFixed(2) + 'h ' + JSON.stringify(arr));
});

console.log('\n=== SUMMARY ===');
console.log('Physical total (all time_entries):', (clockSum + approvedSum + manualSum).toFixed(2));
console.log('Dashboard hoursThisMonth:', stats.hoursThisMonth);
console.log('Schedule sum (actual_hours_worked):', scheduleSum.toFixed(2));

process.exit(0);
