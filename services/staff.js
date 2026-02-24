import { pool } from '../lib/db.js';
import { sanitizeString } from '../lib/sanitize.js';
import { hashPassword } from './auth.js';
import crypto from 'crypto';
import { sendStaffPasswordSetupEmail } from '../lib/email.js';

export async function getStaff(userId) {
  const result = await pool.query(
    `SELECT 
       id, user_id, name, email, role, hourly_rate, employment_type, 
       status, created_at, updated_at, suspicious_pattern_count, 
       last_pattern_check, username, password_set, clockin_id
     FROM staff 
     WHERE user_id = $1 
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

// Get single staff member
export async function getStaffById(staffId, userId) {
  const result = await pool.query(
    'SELECT * FROM staff WHERE id = $1 AND user_id = $2',
    [staffId, userId]
  );
  return result.rows[0];
}

/** Base for username (letters only, no digits) so we can append clock-in code. */
function getUsernameBase(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .replace(/\s+/g, '');
  return base || 'user';
}

function generatePasswordToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createStaff(userId, data) {
  const { name, email, role, hourlyRate, employmentType } = data;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Generate unique 6-digit suffix for username (used for clock-in - last 6 digits of username)
    let code6;
    let attempts = 0;
    while (attempts < 20) {
      code6 = crypto.randomInt(100000, 999999).toString();
      const checkResult = await client.query(
        `SELECT COUNT(*) FROM staff WHERE user_id = $1 AND username IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(TRIM(username), '[^0-9]', '', 'g'), 6) = $2`,
        [userId, code6]
      );
      if (parseInt(checkResult.rows[0].count, 10) === 0) break;
      attempts++;
    }
    if (attempts >= 20) {
      throw new Error('Failed to generate unique 6-digit clock-in code for username');
    }

    // Username = base (from name) + '.' + 6-digit code
    // Example: \"dan\" + 411125 -> \"dan.411125\" (staff use last 6 digits to clock in)
    const username = `${getUsernameBase(name)}.${code6}`;

    const tempPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await hashPassword(tempPassword);

    // Sanitize string inputs to remove null bytes
    const sanitizedName = sanitizeString(name);
    const sanitizedEmail = email ? sanitizeString(email) : email;
    const sanitizedRole = role ? sanitizeString(role) : role;
    
    const result = await client.query(
      `INSERT INTO staff (user_id, name, email, role, hourly_rate, employment_type, username, password_hash, password_set, clockin_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9) 
       RETURNING *`,
      [userId, sanitizedName, sanitizedEmail, sanitizedRole, hourlyRate, employmentType || 'full-time', username, passwordHash, code6]
    );
    const staffId = result.rows[0].id;
    
    // Generate password setup token (expires in 7 days)
    const token = generatePasswordToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Save token to database
    await client.query(
      `INSERT INTO staff_password_tokens (staff_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [staffId, token, expiresAt]
    );
    
    await client.query('COMMIT');
    
    // Send password setup email (don't await - send in background)
    sendStaffPasswordSetupEmail(email, name, username, token).catch(err => {
      console.error('Failed to send password setup email:', err);
      // Don't fail the request if email fails - token is still valid
    });
    
    // Get the created staff member to return
    const staffResult = await pool.query(
      'SELECT * FROM staff WHERE id = $1',
      [staffId]
    );
    
    return staffResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Validate password setup token
export async function validatePasswordToken(token) {
  const result = await pool.query(
    `SELECT spt.*, s.id as staff_id, s.name, s.email, s.username
     FROM staff_password_tokens spt
     JOIN staff s ON spt.staff_id = s.id
     WHERE spt.token = $1 
     AND spt.expires_at > NOW() 
     AND spt.used_at IS NULL`,
    [token]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}

// Reset staff password - generates new token and sends email
export async function resetStaffPassword(staffId, userId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Verify staff belongs to user
    const staffResult = await client.query(
      'SELECT id, name, email, username FROM staff WHERE id = $1 AND user_id = $2',
      [staffId, userId]
    );
    
    if (staffResult.rows.length === 0) {
      throw new Error('Staff member not found');
    }
    
    const staff = staffResult.rows[0];
    
    // Generate new password setup token (expires in 7 days)
    const token = generatePasswordToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Delete any existing unused tokens for this staff member
    await client.query(
      `DELETE FROM staff_password_tokens 
       WHERE staff_id = $1 AND used_at IS NULL`,
      [staffId]
    );
    
    // Save new token to database
    await client.query(
      `INSERT INTO staff_password_tokens (staff_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [staffId, token, expiresAt]
    );
    
    await client.query('COMMIT');
    
    // Send password reset email
    console.log(`[resetStaffPassword] Sending password reset email to ${staff.email} for staff ${staff.name} (ID: ${staffId})`);
    try {
      await sendStaffPasswordSetupEmail(staff.email, staff.name, staff.username, token);
      console.log(`[resetStaffPassword] Password reset email sent successfully to ${staff.email}`);
    } catch (emailError) {
      console.error(`[resetStaffPassword] Failed to send email to ${staff.email}:`, emailError);
      // Don't fail the request if email fails - token is still valid and user can request again
      throw new Error(`Password reset token created but email failed to send: ${emailError.message}`);
    }
    
    return {
      success: true,
      message: 'Password reset email sent successfully'
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Set password using token
export async function setPasswordWithToken(token, newPassword) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Validate token
    const tokenData = await validatePasswordToken(token);
    if (!tokenData) {
      throw new Error('Invalid or expired token');
    }
    
    // Hash new password
    const passwordHash = await hashPassword(newPassword);
    
    // Update staff password and mark as set
    await client.query(
      `UPDATE staff 
       SET password_hash = $1, password_set = TRUE 
       WHERE id = $2`,
      [passwordHash, tokenData.staff_id]
    );
    
    // Mark token as used
    await client.query(
      `UPDATE staff_password_tokens 
       SET used_at = NOW() 
       WHERE token = $1`,
      [token]
    );
    
    await client.query('COMMIT');
    
    return {
      success: true,
      staffId: tokenData.staff_id,
      username: tokenData.username
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Update staff member
export async function updateStaff(staffId, userId, data) {
  const { name, email, role, hourlyRate, employmentType, status } = data;
  
  // Sanitize string inputs to remove null bytes
  const sanitizedName = name !== undefined ? (name ? sanitizeString(name) : name) : undefined;
  const sanitizedEmail = email !== undefined ? (email ? sanitizeString(email) : email) : undefined;
  const sanitizedRole = role !== undefined ? (role ? sanitizeString(role) : role) : undefined;
  
  const result = await pool.query(
    `UPDATE staff 
     SET name = COALESCE($1, name),
         email = COALESCE($2, email),
         role = COALESCE($3, role),
         hourly_rate = COALESCE($4, hourly_rate),
         employment_type = COALESCE($5, employment_type),
         status = COALESCE($6, status)
     WHERE id = $7 AND user_id = $8
     RETURNING *`,
    [sanitizedName, sanitizedEmail, sanitizedRole, hourlyRate, employmentType, status, staffId, userId]
  );
  
  return result.rows[0];
}

// Delete staff member
export async function deleteStaff(staffId, userId) {
  await pool.query(
    'DELETE FROM staff WHERE id = $1 AND user_id = $2',
    [staffId, userId]
  );
}

// Get staff statistics
export async function getStaffStats(userId) {
  const totalStaffResult = await pool.query(
    'SELECT COUNT(*) as count FROM staff WHERE user_id = $1 AND status = $2',
    [userId, 'active']
  );
  
  // Monthly hours: current month only; only actual clock-in to clock-out duration
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const startStr = startOfMonth.toISOString().split('T')[0];
  const endStr = endOfMonth.toISOString().split('T')[0];

  // Hours This Month: ONLY actual clock-in to clock-out (approved per-entry), not manager-set hours
  const hoursResult = await pool.query(
    `WITH approved_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(s.hours, 24)::numeric as shift_hours
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         AND (te.shift_id IS NULL OR s.clock_source IS NULL OR s.clock_source != 'manager')
         AND te.shift_id IS NOT NULL
     ),
     summed AS (
       SELECT staff_id, date, shift_id, shift_hours,
              SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
       FROM approved_clocked
       GROUP BY staff_id, date, shift_id, shift_hours
     )
     SELECT COALESCE(SUM(LEAST(raw_hours, shift_hours)), 0)::numeric(10,2) as total_hours FROM summed`,
    [userId, startStr, endStr]
  );

  // Per-staff actual hours this month (same logic – for attendance table)
  const attendanceHoursResult = await pool.query(
    `WITH approved_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(s.hours, 24)::numeric as shift_hours
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         AND (te.shift_id IS NULL OR s.clock_source IS NULL OR s.clock_source != 'manager')
         AND te.shift_id IS NOT NULL
     ),
     summed AS (
       SELECT staff_id, date, shift_id, shift_hours,
              SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
       FROM approved_clocked
       GROUP BY staff_id, date, shift_id, shift_hours
     )
     SELECT staff_id, COALESCE(SUM(LEAST(raw_hours, shift_hours)), 0)::numeric(10,2) as hours
     FROM summed
     GROUP BY staff_id`,
    [userId, startStr, endStr]
  );
  const attendanceHoursByStaff = {};
  attendanceHoursResult.rows.forEach((r) => {
    attendanceHoursByStaff[r.staff_id] = parseFloat(r.hours || 0);
  });
  
  // Monthly payroll: ONLY actual clock-in to clock-out (approved per-entry)
  const payrollResult = await pool.query(
    `WITH approved_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(s.hours, 24)::numeric as shift_hours
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         AND (te.shift_id IS NULL OR s.clock_source IS NULL OR s.clock_source != 'manager')
         AND te.shift_id IS NOT NULL
     ),
     summed AS (
       SELECT staff_id, date, shift_id, shift_hours,
              SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
       FROM approved_clocked
       GROUP BY staff_id, date, shift_id, shift_hours
     )
     SELECT COALESCE(SUM(LEAST(raw_hours, shift_hours) * st.hourly_rate), 0)::numeric(12,2) as total_cost
     FROM summed c
     JOIN staff st ON st.id = c.staff_id
     WHERE st.user_id = $1`,
    [userId, startStr, endStr]
  );
  
  // Try to get active budget stats for current month (may be null if no budget)
  let budgetSummary = {
    budgetMonthly: null,
    budgetSpentThisMonth: null,
    budgetPercentageUsed: null
  };
  try {
    const budgetStats = await getBudgetStats(userId);
    if (budgetStats && budgetStats.budget && budgetStats.currentMonth) {
      budgetSummary = {
        budgetMonthly: parseFloat(budgetStats.budget.monthlyBudget || budgetStats.budget.monthly_budget || 0),
        budgetSpentThisMonth: parseFloat(budgetStats.currentMonth.spent || 0),
        budgetPercentageUsed: parseFloat(budgetStats.currentMonth.percentageUsed || 0)
      };
    }
  } catch (err) {
    console.log('Budget stats not available for dashboard:', err.message || err);
  }
  
  return {
    totalStaff: parseInt(totalStaffResult.rows[0].count),
    hoursThisMonth: parseFloat(hoursResult.rows[0].total_hours || 0),
    monthlyPayroll: parseFloat(payrollResult.rows[0].total_cost || 0),
    attendanceHoursByStaff,
    ...budgetSummary
  };
}


export async function createTimeEntry(userId, data) {
  const { staffId, date, hoursWorked, overtimeHours, notes } = data;
  
  const result = await pool.query(
    `INSERT INTO time_entries (user_id, staff_id, date, hours_worked, overtime_hours, notes) 
     VALUES ($1, $2, $3, $4, $5, $6) 
     RETURNING *`,
    [userId, staffId, date, hoursWorked, overtimeHours || 0, notes]
  );
  
  return result.rows[0];
}

/** Get clock_in_out time entries pending approval (shifts in review_hours, approved_at IS NULL). */
export async function getPendingTimeEntries(userId, filters = {}) {
  let query = `
    SELECT te.id, te.staff_id, te.date, te.clock_in_time, te.clock_out_time,
           te.hours_worked, te.shift_id, te.entry_type,
           EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0 as period_hours,
           s.name as staff_name, sh.start_time, sh.hours as shift_hours, sh.status as shift_status
    FROM time_entries te
    JOIN staff s ON te.staff_id = s.id
    LEFT JOIN shifts sh ON te.shift_id = sh.id
    WHERE te.user_id = $1
      AND te.entry_type = 'clock_in_out'
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND (te.approved_at IS NULL)
      AND (te.shift_id IS NULL OR sh.status = 'review_hours')
  `;
  const params = [userId];
  let paramCount = 1;
  if (filters.staffId) { paramCount++; query += ` AND te.staff_id = $${paramCount}`; params.push(filters.staffId); }
  if (filters.startDate) { paramCount++; query += ` AND te.date >= $${paramCount}`; params.push(filters.startDate); }
  if (filters.endDate) { paramCount++; query += ` AND te.date <= $${paramCount}`; params.push(filters.endDate); }
  query += ' ORDER BY te.date DESC, te.clock_in_time ASC';

  const result = await pool.query(query, params);
  return result.rows.map(r => ({
    ...r,
    period_hours: parseFloat(Number(r.period_hours || r.hours_worked).toFixed(2)),
  }));
}

export async function approveTimeEntry(timeEntryId, userId) {
  const r = await pool.query(
    `UPDATE time_entries SET approved_at = NOW(), approved_by = $1
     WHERE id = $2 AND user_id = $1
       AND entry_type = 'clock_in_out'
       AND clock_in_time IS NOT NULL AND clock_out_time IS NOT NULL
     RETURNING id, staff_id, date, clock_in_time, clock_out_time, hours_worked, approved_at`,
    [userId, timeEntryId]
  );
  if (r.rows.length === 0) {
    throw new Error('Time entry not found or cannot be approved');
  }
  return r.rows[0];
}

export async function unapproveTimeEntry(timeEntryId, userId) {
  const r = await pool.query(
    `UPDATE time_entries SET approved_at = NULL, approved_by = NULL
     WHERE id = $2 AND user_id = $1 AND entry_type = 'clock_in_out'
     RETURNING id`,
    [userId, timeEntryId]
  );
  if (r.rows.length === 0) {
    throw new Error('Time entry not found or cannot be unapproved');
  }
  return r.rows[0];
}

export async function getTimeEntries(userId, filters = {}) {
  let query = `
    SELECT te.*, s.name as staff_name, s.role, s.hourly_rate,
           CASE
             WHEN te.entry_type = 'clock_in_out' AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
             THEN ROUND((EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric, 2)
             ELSE 0
           END as worked_hours
    FROM time_entries te
    JOIN staff s ON te.staff_id = s.id
    WHERE te.user_id = $1
  `;
  
  const params = [userId];
  let paramCount = 1;
  
  if (filters.staffId) {
    paramCount++;
    query += ` AND te.staff_id = $${paramCount}`;
    params.push(filters.staffId);
  }
  
  if (filters.startDate) {
    paramCount++;
    query += ` AND te.date >= $${paramCount}`;
    params.push(filters.startDate);
  }
  
  if (filters.endDate) {
    paramCount++;
    query += ` AND te.date <= $${paramCount}`;
    params.push(filters.endDate);
  }
  
  query += ' ORDER BY te.date DESC, te.created_at DESC';
  
  const result = await pool.query(query, params);
  return result.rows;
}

/** Payroll for a period: ONLY actual clock-in to clock-out (approved per-entry). */
export async function getPayrollForPeriod(userId, startDate, endDate) {
  const result = await pool.query(
    `WITH
     approved_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(sh.hours, 24)::numeric as shift_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date BETWEEN $2 AND $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         AND (te.shift_id IS NULL OR sh.clock_source IS NULL OR sh.clock_source != 'manager')
         AND te.shift_id IS NOT NULL
     ),
     summed_clocked AS (
       SELECT staff_id, date, shift_id, shift_hours,
              SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
       FROM approved_clocked
       GROUP BY staff_id, date, shift_id, shift_hours
     ),
     from_clocked AS (
       SELECT staff_id, LEAST(raw_hours, shift_hours)::numeric as hours_val
       FROM summed_clocked
     )
     SELECT s.id as staff_id, s.name as staff_name, s.role, s.hourly_rate,
            COALESCE(SUM(c.hours_val), 0)::numeric(10,2) as hours_worked,
            COALESCE(SUM(c.hours_val * s.hourly_rate), 0)::numeric(12,2) as total_pay
     FROM staff s
     LEFT JOIN from_clocked c ON c.staff_id = s.id
     WHERE s.user_id = $1 AND s.status = 'active'
     GROUP BY s.id, s.name, s.role, s.hourly_rate
     HAVING COALESCE(SUM(c.hours_val), 0) > 0
     ORDER BY s.name`,
    [userId, startDate, endDate]
  );
  const staff = result.rows.map((r) => ({
    id: r.staff_id,
    name: r.staff_name,
    role: r.role,
    hourlyRate: parseFloat(r.hourly_rate),
    hoursWorked: parseFloat(r.hours_worked || 0),
    totalPay: parseFloat(r.total_pay || 0)
  }));
  const totals = staff.reduce(
    (acc, s) => ({ totalHours: acc.totalHours + s.hoursWorked, totalPay: acc.totalPay + s.totalPay }),
    { totalHours: 0, totalPay: 0 }
  );
  return { staff, totals };
}

// Get monthly earnings chart data (daily breakdown)
export async function getMonthlyEarningsChart(userId, year, month) {
  // Default to current month if not provided
  const now = new Date();
  const targetYear = year || now.getFullYear();
  const targetMonth = month !== undefined ? month : now.getMonth();
  
  // Get first and last day of the month
  const firstDay = new Date(targetYear, targetMonth, 1);
  const lastDay = new Date(targetYear, targetMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  
  const entries = await pool.query(
    `WITH approved_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(sh.hours, 24)::numeric as shift_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         AND (te.shift_id IS NULL OR sh.clock_source IS NULL OR sh.clock_source != 'manager')
         AND te.shift_id IS NOT NULL
     ),
     summed AS (
       SELECT staff_id, date, shift_hours,
              SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
       FROM approved_clocked
       GROUP BY staff_id, date, shift_id, shift_hours
     )
     SELECT c.date, s.hourly_rate,
            LEAST(c.raw_hours, c.shift_hours)::numeric as duration_hours
     FROM summed c
     JOIN staff s ON s.id = c.staff_id
     ORDER BY c.date ASC`,
    [userId, firstDay.toISOString().split('T')[0], lastDay.toISOString().split('T')[0]]
  );
  
  const dailyTotals = {};
  let totalThisMonth = 0;
  
  entries.rows.forEach(entry => {
    let dateStr;
    if (entry.date instanceof Date) {
      dateStr = entry.date.toISOString().split('T')[0];
    } else if (typeof entry.date === 'string') {
      dateStr = entry.date.split('T')[0];
    } else {
      dateStr = new Date(entry.date).toISOString().split('T')[0];
    }
    const durationHours = parseFloat(entry.duration_hours || 0);
    const hourlyRate = parseFloat(entry.hourly_rate || 0);
    const cost = durationHours * hourlyRate;
    
    if (!dailyTotals[dateStr]) {
      dailyTotals[dateStr] = 0;
    }
    dailyTotals[dateStr] += cost;
    totalThisMonth += cost;
  });
  
  // Build array with all days of the month
  const chartData = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(targetYear, targetMonth, day);
    const dateStr = date.toISOString().split('T')[0];
    const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });
    
    chartData.push({
      date: dateStr,
      day: day,
      dayName: dayName,
      amount: dailyTotals[dateStr] || 0
    });
  }
  
  return {
    chartData,
    totalThisMonth,
    month: targetMonth + 1, // 1-indexed month
    year: targetYear,
    daysInMonth
  };
}

export async function deleteTimeEntry(entryId, userId) {
  await pool.query(
    'DELETE FROM time_entries WHERE id = $1 AND user_id = $2',
    [entryId, userId]
  );
}


export async function createBudget(userId, data) {
  const { name, monthlyBudget, startDate, endDate } = data;
  
  // Validate required fields
  if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
    throw new Error('Name, monthly budget, and start date are required');
  }
  
  // Validate and format startDate
  const startDateObj = new Date(startDate);
  if (isNaN(startDateObj.getTime())) {
    throw new Error('Invalid start date format. Expected YYYY-MM-DD format.');
  }
  const formattedStartDate = startDateObj.toISOString().split('T')[0];
  
  // Set endDate to end of month if not provided or empty
  let finalEndDate = endDate;
  if (!finalEndDate || finalEndDate === '' || finalEndDate === null || finalEndDate === undefined) {
    // Calculate end of month from start date
    const end = new Date(startDateObj.getFullYear(), startDateObj.getMonth() + 1, 0);
    finalEndDate = end.toISOString().split('T')[0];
  } else {
    // Validate endDate format if provided
    const endDateObj = new Date(finalEndDate);
    if (isNaN(endDateObj.getTime())) {
      throw new Error('Invalid end date format. Expected YYYY-MM-DD format.');
    }
    finalEndDate = endDateObj.toISOString().split('T')[0];
    
    // Ensure endDate is after startDate
    if (endDateObj < startDateObj) {
      throw new Error('End date must be after start date');
    }
  }
  
  // Ensure monthlyBudget is a number
  const budgetAmount = parseFloat(monthlyBudget);
  if (isNaN(budgetAmount) || budgetAmount < 0) {
    throw new Error('Monthly budget must be a positive number');
  }
  
  try {
    // Validate userId is a valid number
    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum) || userIdNum <= 0) {
      throw new Error('Invalid user ID');
    }
    
    console.log('Creating budget with data:', {
      userId: userIdNum,
      name,
      monthly_budget: budgetAmount,
      start_date: formattedStartDate,
      end_date: finalEndDate
    });
    
    const result = await pool.query(
      `INSERT INTO budgets (user_id, name, monthly_budget, start_date, end_date, status) 
       VALUES ($1, $2, $3, $4, $5, 'active') 
       RETURNING *`,
      [userIdNum, name, budgetAmount, formattedStartDate, finalEndDate]
    );
    
    if (!result.rows || result.rows.length === 0) {
      throw new Error('Failed to create budget - no data returned');
    }
    
    return result.rows[0];
  } catch (dbError) {
    console.error('Database error in createBudget:', dbError);
    // Re-throw with more context if it's a database error
    if (dbError.code) {
      throw new Error(`Database error: ${dbError.message || dbError.detail || 'Failed to create budget'}`);
    }
    throw dbError;
  }
}

export async function getActiveBudget(userId) {
  const result = await pool.query(
    `SELECT * FROM budgets 
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC 
     LIMIT 1`,
    [userId]
  );
  
  return result.rows[0];
}

export async function getBudgets(userId) {
  const result = await pool.query(
    'SELECT * FROM budgets WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  
  return result.rows;
}

// Update budget
export async function updateBudget(userId, budgetId, data) {
  const { name, monthlyBudget, startDate, endDate, status } = data;
  
  // Validate required fields
  if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
    throw new Error('Name, monthly budget, and start date are required');
  }
  
  // Validate and format startDate
  const startDateObj = new Date(startDate);
  if (isNaN(startDateObj.getTime())) {
    throw new Error('Invalid start date format. Expected YYYY-MM-DD format.');
  }
  const formattedStartDate = startDateObj.toISOString().split('T')[0];
  
  // Set endDate to end of month if not provided or empty
  let finalEndDate = endDate;
  if (!finalEndDate || finalEndDate === '' || finalEndDate === null || finalEndDate === undefined) {
    // Calculate end of month from start date
    const end = new Date(startDateObj.getFullYear(), startDateObj.getMonth() + 1, 0);
    finalEndDate = end.toISOString().split('T')[0];
  } else {
    // Validate endDate format if provided
    const endDateObj = new Date(finalEndDate);
    if (isNaN(endDateObj.getTime())) {
      throw new Error('Invalid end date format. Expected YYYY-MM-DD format.');
    }
    finalEndDate = endDateObj.toISOString().split('T')[0];
    
    // Ensure endDate is after startDate
    if (endDateObj < startDateObj) {
      throw new Error('End date must be after start date');
    }
  }
  
  // Ensure monthlyBudget is a number
  const budgetAmount = parseFloat(monthlyBudget);
  if (isNaN(budgetAmount) || budgetAmount < 0) {
    throw new Error('Monthly budget must be a positive number');
  }
  
  // Validate userId and budgetId
  const userIdNum = parseInt(userId);
  const budgetIdNum = parseInt(budgetId);
  if (isNaN(userIdNum) || userIdNum <= 0 || isNaN(budgetIdNum) || budgetIdNum <= 0) {
    throw new Error('Invalid user ID or budget ID');
  }
  
  try {
    // Update the budget
    const result = await pool.query(
      `UPDATE budgets 
       SET name = $1, monthly_budget = $2, start_date = $3, end_date = $4, 
           status = COALESCE($5, status), updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [name, budgetAmount, formattedStartDate, finalEndDate, status || 'active', budgetIdNum, userIdNum]
    );
    
    if (!result.rows || result.rows.length === 0) {
      throw new Error('Budget not found or you do not have permission to update it');
    }
    
    return result.rows[0];
  } catch (dbError) {
    console.error('Database error in updateBudget:', dbError);
    if (dbError.code) {
      throw new Error(`Database error: ${dbError.message || dbError.detail || 'Failed to update budget'}`);
    }
    throw dbError;
  }
}

// Get budget statistics (spent vs budget for current month)
export async function getBudgetStats(userId) {
  try {
    // Get active budget
    const budget = await getActiveBudget(userId);
    if (!budget) {
      return null;
    }

    // Get current month's start and end dates
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Format dates as YYYY-MM-DD strings
    const startDateStr = firstDay.toISOString().split('T')[0];
    const endDateStr = lastDay.toISOString().split('T')[0];
    
    // Same as monthlyPayroll: ONLY actual clock-in to clock-out
    const spentResult = await pool.query(
      `WITH approved_clocked AS (
         SELECT te.staff_id, te.date, te.shift_id, te.clock_in_time, te.clock_out_time, COALESCE(s.hours, 24)::numeric as shift_hours
         FROM time_entries te
         LEFT JOIN shifts s ON s.id = te.shift_id
         WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
           AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
           AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
           AND (te.shift_id IS NULL OR s.clock_source IS NULL OR s.clock_source != 'manager')
           AND te.shift_id IS NOT NULL
       ),
       summed AS (
         SELECT staff_id, date, shift_id, shift_hours,
                SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0) as raw_hours
         FROM approved_clocked
         GROUP BY staff_id, date, shift_id, shift_hours
       )
       SELECT COALESCE(SUM(LEAST(raw_hours, shift_hours) * st.hourly_rate), 0)::numeric(12,2) as total_spent
       FROM summed c
       JOIN staff st ON st.id = c.staff_id
       WHERE st.user_id = $1`,
      [userId, startDateStr, endDateStr]
    );
    const totalSpent = parseFloat(spentResult.rows[0]?.total_spent || 0);
    
    const monthlyBudget = parseFloat(budget.monthly_budget || 0);
    const remaining = monthlyBudget - totalSpent;
    const percentageUsed = monthlyBudget > 0 ? (totalSpent / monthlyBudget) * 100 : 0;
    
    return {
      budget: {
        id: budget.id,
        name: budget.name,
        monthlyBudget: monthlyBudget,
        startDate: budget.start_date,
        endDate: budget.end_date
      },
      currentMonth: {
        spent: totalSpent,
        remaining: remaining,
        percentageUsed: Math.min(100, Math.max(0, percentageUsed)),
        isOverBudget: totalSpent > monthlyBudget
      }
    };
  } catch (error) {
    console.error('Error in getBudgetStats:', error);
    throw error; // Re-throw to be handled by the endpoint
  }
}
