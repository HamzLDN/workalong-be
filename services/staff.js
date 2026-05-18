import { pool } from '../lib/db.js';
import { sanitizeString } from '../lib/sanitize.js';
import { hashPassword } from './auth.js';
import { deriveClockPeriodOvertimePayrollHint } from './shifts.js';
import crypto from 'crypto';
import { sendStaffPasswordSetupEmail } from '../lib/email.js';

export async function getStaff(userId) {
  const result = await pool.query(
    `SELECT 
       s.id, s.user_id, s.name, s.email, s.role, s.hourly_rate, s.employment_type, 
       s.status, s.access_role, s.created_at, s.updated_at, s.suspicious_pattern_count, 
       s.last_pattern_check, s.username, s.password_set, s.clockin_id,
       s.department_id, d.name AS department_name,
       s.branch_id, b.name AS branch_name,
       s.manager_id, m.name AS manager_name
     FROM staff s
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN branches b ON b.id = s.branch_id
     LEFT JOIN staff m ON m.id = s.manager_id
     WHERE s.user_id = $1 
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function getStaffById(staffId, userId) {
  const result = await pool.query('SELECT * FROM staff WHERE id = $1 AND user_id = $2', [
    staffId,
    userId,
  ]);
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

function parseOptionalAssignmentId(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const id = parseInt(value, 10);
  if (Number.isNaN(id)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return id;
}

const ACCESS_ROLES_ALLOWED = new Set(['employee', 'manager', 'payroll_admin']);

export function parseAccessRoleOrThrow(value) {
  if (value === undefined || value === null) return undefined;
  let s = typeof value === 'string' ? value.trim() : String(value).trim();
  if (s === '') return undefined;
  try {
    s = s.normalize('NFKC');
  } catch {
  }
  s = s.replace(/^\uFEFF/, '');
  const lower = s.toLowerCase();
  if (!ACCESS_ROLES_ALLOWED.has(lower)) {
    throw new Error('Invalid access role');
  }
  return lower;
}

function coalesceAccessRoleForCreate(accessRole) {
  if (accessRole === undefined || accessRole === null) return 'employee';
  try {
    return parseAccessRoleOrThrow(accessRole) ?? 'employee';
  } catch {
    return 'employee';
  }
}

async function assertAssignmentOwnedByUser(client, table, id, userId, label) {
  if (id == null) return;
  const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  if (result.rows.length === 0) {
    throw new Error(`${label} not found`);
  }
}

export async function createStaff(userId, data) {
  const { name, email, role, hourlyRate, employmentType, accessRole = 'employee' } = data;
  const departmentId = parseOptionalAssignmentId(data.departmentId, 'department ID');
  const branchId = parseOptionalAssignmentId(data.branchId, 'branch ID');
  const managerId = parseOptionalAssignmentId(data.managerId, 'manager ID');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await assertAssignmentOwnedByUser(client, 'departments', departmentId, userId, 'Department');
    await assertAssignmentOwnedByUser(client, 'branches', branchId, userId, 'Branch');
    await assertAssignmentOwnedByUser(client, 'staff', managerId, userId, 'Manager');

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

    const username = `${getUsernameBase(name)}.${code6}`;

    const tempPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await hashPassword(tempPassword);

    const sanitizedName = sanitizeString(name);
    const sanitizedEmail = email ? sanitizeString(email) : email;
    const sanitizedRole = role ? sanitizeString(role) : role;

    const result = await client.query(
      `INSERT INTO staff (user_id, name, email, role, hourly_rate, employment_type, username, password_hash, password_set, clockin_id, department_id, branch_id, manager_id, access_role) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9, $10, $11, $12, $13) 
       RETURNING *`,
      [
        userId,
        sanitizedName,
        sanitizedEmail,
        sanitizedRole,
        hourlyRate,
        employmentType || 'full-time',
        username,
        passwordHash,
        code6,
        departmentId,
        branchId,
        managerId,
        coalesceAccessRoleForCreate(accessRole),
      ]
    );
    const staffId = result.rows[0].id;

    const token = generatePasswordToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await client.query(
      `INSERT INTO staff_password_tokens (staff_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [staffId, token, expiresAt]
    );

    await client.query('COMMIT');

    sendStaffPasswordSetupEmail(email, name, username, token).catch((err) => {
      console.error('Failed to send password setup email:', err);
    });

    const staffResult = await pool.query('SELECT * FROM staff WHERE id = $1', [staffId]);

    return staffResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

export async function resetStaffPassword(staffId, userId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const staffResult = await client.query(
      'SELECT id, name, email, username FROM staff WHERE id = $1 AND user_id = $2',
      [staffId, userId]
    );

    if (staffResult.rows.length === 0) {
      throw new Error('Staff member not found');
    }

    const staff = staffResult.rows[0];

    const token = generatePasswordToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await client.query(
      `DELETE FROM staff_password_tokens 
       WHERE staff_id = $1 AND used_at IS NULL`,
      [staffId]
    );

    await client.query(
      `INSERT INTO staff_password_tokens (staff_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [staffId, token, expiresAt]
    );

    await client.query('COMMIT');

    try {
      await sendStaffPasswordSetupEmail(staff.email, staff.name, staff.username, token);
    } catch (emailError) {
      console.error(`[resetStaffPassword] Failed to send email to ${staff.email}:`, emailError);
      throw new Error(
        `Password reset token created but email failed to send: ${emailError.message}`
      );
    }

    return {
      success: true,
      message: 'Password reset email sent successfully',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setPasswordWithToken(token, newPassword) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tokenData = await validatePasswordToken(token);
    if (!tokenData) {
      throw new Error('Invalid or expired token');
    }

    const passwordHash = await hashPassword(newPassword);

    await client.query(
      `UPDATE staff 
       SET password_hash = $1, password_set = TRUE 
       WHERE id = $2`,
      [passwordHash, tokenData.staff_id]
    );

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
      username: tokenData.username,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStaff(staffId, userId, data) {
  const { name, email, role, hourlyRate, employmentType, status, accessRole } = data;
  const departmentId = parseOptionalAssignmentId(data.departmentId, 'department ID');
  const branchId = parseOptionalAssignmentId(data.branchId, 'branch ID');
  const managerId = parseOptionalAssignmentId(data.managerId, 'manager ID');

  const sanitizedName = name !== undefined ? (name ? sanitizeString(name) : name) : undefined;
  const sanitizedEmail = email !== undefined ? (email ? sanitizeString(email) : email) : undefined;
  const sanitizedRole = role !== undefined ? (role ? sanitizeString(role) : role) : undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT id, department_id, branch_id, manager_id FROM staff WHERE id = $1 AND user_id = $2',
      [staffId, userId]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await assertAssignmentOwnedByUser(client, 'departments', departmentId, userId, 'Department');
    await assertAssignmentOwnedByUser(client, 'branches', branchId, userId, 'Branch');
    await assertAssignmentOwnedByUser(client, 'staff', managerId, userId, 'Manager');

    const staffIdNum = parseInt(staffId, 10);
    if (managerId != null && managerId === staffIdNum) {
      throw new Error('A staff member cannot manage themselves');
    }

    const updates = [];
    const values = [];
    let param = 1;
    const addUpdate = (column, value) => {
      updates.push(`${column} = $${param++}`);
      values.push(value);
    };

    if (sanitizedName !== undefined) addUpdate('name', sanitizedName);
    if (sanitizedEmail !== undefined) addUpdate('email', sanitizedEmail);
    if (sanitizedRole !== undefined) addUpdate('role', sanitizedRole);
    if (hourlyRate !== undefined) addUpdate('hourly_rate', hourlyRate);
    if (employmentType !== undefined) addUpdate('employment_type', employmentType);
    if (status !== undefined) addUpdate('status', status);
    if (accessRole !== undefined) {
      const roleStr = parseAccessRoleOrThrow(accessRole);
      if (roleStr !== undefined) {
        addUpdate('access_role', roleStr);
      }
    }
    if (departmentId !== undefined) addUpdate('department_id', departmentId);
    if (branchId !== undefined) addUpdate('branch_id', branchId);
    if (managerId !== undefined) addUpdate('manager_id', managerId);

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return current.rows[0];
    }

    addUpdate('updated_at', new Date());
    values.push(staffId, userId);

    const result = await client.query(
      `UPDATE staff 
       SET ${updates.join(', ')}
       WHERE id = $${param++} AND user_id = $${param}
       RETURNING *`,
      values
    );

    const before = current.rows[0];
    if (departmentId !== undefined || branchId !== undefined || managerId !== undefined) {
      await client.query(
        `INSERT INTO staff_assignment_history
         (user_id, staff_id, from_department_id, to_department_id, from_branch_id, to_branch_id, from_manager_id, to_manager_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          staffId,
          before.department_id,
          departmentId === undefined ? before.department_id : departmentId,
          before.branch_id,
          branchId === undefined ? before.branch_id : branchId,
          before.manager_id,
          managerId === undefined ? before.manager_id : managerId,
          data.assignmentReason || null,
        ]
      );
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteStaff(staffId, userId) {
  await pool.query('DELETE FROM staff WHERE id = $1 AND user_id = $2', [staffId, userId]);
}

export async function getStaffStats(userId, clientDate = null) {
  const totalStaffResult = await pool.query(
    'SELECT COUNT(*) as count FROM staff WHERE user_id = $1 AND status = $2',
    [userId, 'active']
  );

  let startStr, endStr;
  if (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
    const [y, m] = clientDate.split('-').map(Number);
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  } else {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    startStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
  }

  const hoursResult = await pool.query(
    `WITH from_clocked AS (
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
         AND NOT (te.shift_id IS NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date
             AND te2.entry_type = 'approved_shift' AND te2.shift_id IS NOT NULL
         ))
         AND NOT (te.shift_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
             AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.approved_at IS NOT NULL
         ))
     ),
     from_manual AS (
       SELECT te.staff_id, te.date, te.shift_id,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours
       FROM time_entries te
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'manual'
     ),
     combined AS (
       SELECT staff_id, date, shift_id, raw_hours FROM from_clocked
       UNION ALL
       SELECT staff_id, date, shift_id, raw_hours FROM from_approved_shift
       UNION ALL
       SELECT staff_id, date, shift_id, raw_hours FROM from_manual
     )
     SELECT COALESCE(SUM(raw_hours), 0)::numeric(10,2) as total_hours FROM combined`,
    [userId, startStr, endStr]
  );

  const attendanceHoursResult = await pool.query(
    `WITH from_clocked AS (
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
         AND NOT (te.shift_id IS NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date
             AND te2.entry_type = 'approved_shift' AND te2.shift_id IS NOT NULL
         ))
         AND NOT (te.shift_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
             AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.approved_at IS NOT NULL
         ))
     ),
     from_manual AS (
       SELECT te.staff_id, te.date, te.shift_id,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours
       FROM time_entries te
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'manual'
     ),
     combined AS (
       SELECT staff_id, raw_hours FROM from_clocked
       UNION ALL SELECT staff_id, raw_hours FROM from_approved_shift
       UNION ALL SELECT staff_id, raw_hours FROM from_manual
     )
     SELECT staff_id, COALESCE(SUM(raw_hours), 0)::numeric(10,2) as hours
     FROM combined
     GROUP BY staff_id`,
    [userId, startStr, endStr]
  );
  const attendanceHoursByStaff = {};
  attendanceHoursResult.rows.forEach((r) => {
    attendanceHoursByStaff[r.staff_id] = parseFloat(r.hours || 0);
  });

  const payrollResult = await pool.query(
    `WITH from_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as raw_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as pay_hours
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
       GROUP BY te.staff_id, te.date, te.shift_id, s.hours
     ),
     from_approved_shift AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  COALESCE(s.hours, 24)::numeric
                )
              END as pay_hours
       FROM time_entries te
       LEFT JOIN shifts s ON s.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'approved_shift'
         AND NOT (te.shift_id IS NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date
             AND te2.entry_type = 'approved_shift' AND te2.shift_id IS NOT NULL
         ))
         AND NOT (te.shift_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
             AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.approved_at IS NOT NULL
         ))
     ),
     from_manual AS (
       SELECT te.staff_id, te.date, te.shift_id, 24::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  24::numeric
                )
              END as pay_hours
       FROM time_entries te
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'manual'
     ),
     combined AS (
       SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_clocked
       UNION ALL SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_approved_shift
       UNION ALL SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_manual
     )
     SELECT COALESCE(SUM(c.pay_hours * st.hourly_rate), 0)::numeric(12,2) as total_cost
     FROM combined c
     JOIN staff st ON st.id = c.staff_id
     WHERE st.user_id = $1`,
    [userId, startStr, endStr]
  );

  let budgetSummary = {
    budgetMonthly: null,
    budgetSpentThisMonth: null,
    budgetPercentageUsed: null,
  };
  try {
    const budgetStats = await getBudgetStats(userId, clientDate);
    if (budgetStats && budgetStats.budget && budgetStats.currentMonth) {
      budgetSummary = {
        budgetMonthly: parseFloat(
          budgetStats.budget.monthlyBudget || budgetStats.budget.monthly_budget || 0
        ),
        budgetSpentThisMonth: parseFloat(budgetStats.currentMonth.spent || 0),
        budgetPercentageUsed: parseFloat(budgetStats.currentMonth.percentageUsed || 0),
      };
    }
  } catch (err) {
  }

  return {
    totalStaff: parseInt(totalStaffResult.rows[0].count),
    hoursThisMonth: parseFloat(hoursResult.rows[0].total_hours || 0),
    monthlyPayroll: parseFloat(payrollResult.rows[0].total_cost || 0),
    attendanceHoursByStaff,
    ...budgetSummary,
  };
}

const LEAVE_CATEGORIES = new Set(['none', 'paid_leave', 'unpaid_leave', 'sick_leave']);

export async function createTimeEntry(userId, data) {
  const { staffId, date, hoursWorked, overtimeHours, notes, leaveCategory } = data;
  const lc = LEAVE_CATEGORIES.has(leaveCategory) ? leaveCategory : 'none';

  const result = await pool.query(
    `INSERT INTO time_entries (user_id, staff_id, date, hours_worked, overtime_hours, notes, entry_type, leave_category)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
     RETURNING *`,
    [userId, staffId, date, hoursWorked, overtimeHours || 0, notes, lc]
  );

  return result.rows[0];
}

/** Get clock_in_out time entries pending head office confirmation (approved_at IS NULL). */
export async function getPendingTimeEntries(userId, filters = {}) {
  let query = `
    SELECT te.id, te.staff_id, te.date, te.clock_in_time, te.clock_out_time,
           te.hours_worked, te.shift_id, te.entry_type,
           te.staff_approved_at, te.staff_approved_by,
           NULLIF(TRIM(CONCAT(sm.name, ' ', COALESCE(sm.lastname, ''))), '') AS staff_approved_by_name,
           EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0 as period_hours,
           s.name as staff_name, sh.start_time, sh.hours as shift_hours, sh.status as shift_status
    FROM time_entries te
    JOIN staff s ON te.staff_id = s.id
    LEFT JOIN staff sm ON sm.id = te.staff_approved_by
    LEFT JOIN shifts sh ON te.shift_id = sh.id
    WHERE te.user_id = $1
      AND te.entry_type = 'clock_in_out'
      AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
      AND (te.approved_at IS NULL)
      AND (te.shift_id IS NULL OR sh.status = 'review_hours')
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
  query += ' ORDER BY te.date DESC, te.clock_in_time ASC';

  const result = await pool.query(query, params);
  return result.rows.map((r) => ({
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
     RETURNING id, staff_id, shift_id, date, clock_in_time, clock_out_time, hours_worked,
               overtime_hours, notes,
               approved_at, approved_by, staff_approved_at, staff_approved_by,
               (SELECT hours FROM shifts WHERE id = time_entries.shift_id) AS shift_scheduled_hours`,
    [userId, timeEntryId]
  );
  if (r.rows.length === 0) {
    throw new Error('Time entry not found or cannot be approved');
  }
  const row = r.rows[0];
  const [nameRes, staffRec] = await Promise.all([
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(name), ''), email) AS approved_by_user_name FROM users WHERE id = $1`,
      [userId]
    ),
    row.staff_approved_by
      ? pool.query(
          `SELECT NULLIF(TRIM(CONCAT(name, ' ', COALESCE(lastname, ''))), '') AS n
           FROM staff WHERE id = $1`,
          [row.staff_approved_by]
        )
      : Promise.resolve({ rows: [{}] }),
  ]);
  const overtime_payroll_hint = deriveClockPeriodOvertimePayrollHint(row);
  return {
    ...row,
    approved_by_user_name: nameRes.rows[0]?.approved_by_user_name ?? null,
    staff_approved_by_name: staffRec.rows[0]?.n ?? null,
    overtime_payroll_hint,
  };
}

export async function unapproveTimeEntry(timeEntryId, userId) {
  const r = await pool.query(
    `UPDATE time_entries SET approved_at = NULL, approved_by = NULL
     WHERE id = $2 AND user_id = $1 AND entry_type = 'clock_in_out'
     RETURNING id, staff_id, shift_id, date, clock_in_time, clock_out_time, hours_worked,
               overtime_hours, notes, approved_at, approved_by, staff_approved_at, staff_approved_by,
               (SELECT hours FROM shifts WHERE id = time_entries.shift_id) AS shift_scheduled_hours`,
    [userId, timeEntryId]
  );
  if (r.rows.length === 0) {
    throw new Error('Time entry not found or cannot be unapproved');
  }
  const row = r.rows[0];
  const overtime_payroll_hint = deriveClockPeriodOvertimePayrollHint(row);
  return {
    ...row,
    overtime_payroll_hint,
  };
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

/** Payroll for a period: clock_in_out + approved_shift + manual (same sources as dashboard). */
export async function getPayrollForPeriod(userId, startDate, endDate) {
  const result = await pool.query(
    `WITH from_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(sh.hours, 24)::numeric as shift_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as raw_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as pay_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date BETWEEN $2 AND $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
       GROUP BY te.staff_id, te.date, te.shift_id, sh.hours
     ),
     from_approved_shift AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(sh.hours, 24)::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  COALESCE(sh.hours, 24)::numeric
                )
              END as pay_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date BETWEEN $2 AND $3
         AND te.entry_type = 'approved_shift'
         AND NOT (te.shift_id IS NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date
             AND te2.entry_type = 'approved_shift' AND te2.shift_id IS NOT NULL
         ))
         AND NOT (te.shift_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
             AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.approved_at IS NOT NULL
         ))
     ),
     from_manual AS (
       SELECT te.staff_id, te.date, te.shift_id, 24::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  24::numeric
                )
              END as pay_hours
       FROM time_entries te
       WHERE te.user_id = $1 AND te.date BETWEEN $2 AND $3
         AND te.entry_type = 'manual'
     ),
     combined AS (
       SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_clocked
       UNION ALL SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_approved_shift
       UNION ALL SELECT staff_id, shift_hours, raw_hours, pay_hours FROM from_manual
     ),
     hours_val AS (
       SELECT staff_id, pay_hours::numeric as hours_val
       FROM combined
     )
     SELECT s.id as staff_id, s.name as staff_name, s.role, s.hourly_rate,
            COALESCE(SUM(c.hours_val), 0)::numeric(10,2) as hours_worked,
            COALESCE(SUM(c.hours_val * s.hourly_rate), 0)::numeric(12,2) as total_pay
     FROM staff s
     LEFT JOIN hours_val c ON c.staff_id = s.id
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
    totalPay: parseFloat(r.total_pay || 0),
  }));
  const totals = staff.reduce(
    (acc, s) => ({
      totalHours: acc.totalHours + s.hoursWorked,
      totalPay: acc.totalPay + s.totalPay,
    }),
    { totalHours: 0, totalPay: 0 }
  );
  return { staff, totals };
}

export async function getMonthlyEarningsChart(userId, year, month) {
  const now = new Date();
  const targetYear = year || now.getFullYear();
  const targetMonth = month !== undefined ? month : now.getMonth();

  const startStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-01`;
  const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const endStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const entries = await pool.query(
    `WITH from_clocked AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(sh.hours, 24)::numeric as shift_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as raw_hours,
              SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as pay_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
       GROUP BY te.staff_id, te.date, te.shift_id, sh.hours
     ),
     from_approved_shift AS (
       SELECT te.staff_id, te.date, te.shift_id, COALESCE(sh.hours, 24)::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  COALESCE(sh.hours, 24)::numeric
                )
              END as pay_hours
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'approved_shift'
         AND NOT (te.shift_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM time_entries te2
           WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
             AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.approved_at IS NOT NULL
         ))
     ),
     from_manual AS (
       SELECT te.staff_id, te.date, te.shift_id, 24::numeric as shift_hours,
              (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
              CASE
                WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                ELSE LEAST(
                  (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                  24::numeric
                )
              END as pay_hours
       FROM time_entries te
       WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
         AND te.entry_type = 'manual'
     ),
     combined AS (
       SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_clocked
       UNION ALL SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_approved_shift
       UNION ALL SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_manual
     )
     SELECT c.date, s.hourly_rate,
            c.pay_hours::numeric as duration_hours
     FROM combined c
     JOIN staff s ON s.id = c.staff_id
     ORDER BY c.date ASC`,
    [userId, startStr, endStr]
  );

  const dailyTotals = {};
  let totalThisMonth = 0;

  entries.rows.forEach((entry) => {
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

  const chartData = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(targetYear, targetMonth, day);
    const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });

    chartData.push({
      date: dateStr,
      day: day,
      dayName: dayName,
      amount: dailyTotals[dateStr] || 0,
    });
  }

  return {
    chartData,
    totalThisMonth,
    month: targetMonth + 1, // 1-indexed month
    year: targetYear,
    daysInMonth,
  };
}

export async function updateTimeEntry(userId, timeEntryId, data) {
  const { staffId, date, hoursWorked, overtimeHours, notes, leaveCategory } = data;
  const lc = LEAVE_CATEGORIES.has(leaveCategory) ? leaveCategory : 'none';
  const ot =
    lc === 'paid_leave' || lc === 'unpaid_leave' || lc === 'sick_leave'
      ? 0
      : parseFloat(overtimeHours || 0) || 0;

  const r = await pool.query(
    `UPDATE time_entries
     SET staff_id = $1, date = $2, hours_worked = $3, overtime_hours = $4,
         notes = $5, leave_category = $6, updated_at = NOW()
     WHERE id = $7 AND user_id = $8 AND entry_type = 'manual'
     RETURNING *`,
    [staffId, date, hoursWorked, ot, notes ?? null, lc, timeEntryId, userId]
  );
  if (r.rows.length === 0) {
    throw new Error(
      'Time entry not found or cannot be edited (only manually logged entries can be changed here)'
    );
  }
  return r.rows[0];
}

export async function deleteTimeEntry(entryId, userId) {
  const r = await pool.query(
    `DELETE FROM time_entries
     WHERE id = $1 AND user_id = $2 AND entry_type = 'manual'
     RETURNING id`,
    [entryId, userId]
  );
  if (r.rows.length === 0) {
    throw new Error(
      'Time entry not found or cannot be deleted (clock-in entries are managed from the schedule)'
    );
  }
}

export async function createBudget(userId, data) {
  const { name, monthlyBudget, startDate, endDate } = data;

  if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
    throw new Error('Name, monthly budget, and start date are required');
  }

  const startDateObj = new Date(startDate);
  if (isNaN(startDateObj.getTime())) {
    throw new Error('Invalid start date format. Expected YYYY-MM-DD format.');
  }
  const formattedStartDate = startDateObj.toISOString().split('T')[0];

  let finalEndDate = endDate;
  if (!finalEndDate || finalEndDate === '' || finalEndDate === null || finalEndDate === undefined) {
    const end = new Date(startDateObj.getFullYear(), startDateObj.getMonth() + 1, 0);
    finalEndDate = end.toISOString().split('T')[0];
  } else {
    const endDateObj = new Date(finalEndDate);
    if (isNaN(endDateObj.getTime())) {
      throw new Error('Invalid end date format. Expected YYYY-MM-DD format.');
    }
    finalEndDate = endDateObj.toISOString().split('T')[0];

    if (endDateObj < startDateObj) {
      throw new Error('End date must be after start date');
    }
  }

  const budgetAmount = parseFloat(monthlyBudget);
  if (isNaN(budgetAmount) || budgetAmount < 0) {
    throw new Error('Monthly budget must be a positive number');
  }

  try {
    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum) || userIdNum <= 0) {
      throw new Error('Invalid user ID');
    }


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
    if (dbError.code) {
      throw new Error(
        `Database error: ${dbError.message || dbError.detail || 'Failed to create budget'}`
      );
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

export async function updateBudget(userId, budgetId, data) {
  const { name, monthlyBudget, startDate, endDate, status } = data;

  if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
    throw new Error('Name, monthly budget, and start date are required');
  }

  const startDateObj = new Date(startDate);
  if (isNaN(startDateObj.getTime())) {
    throw new Error('Invalid start date format. Expected YYYY-MM-DD format.');
  }
  const formattedStartDate = startDateObj.toISOString().split('T')[0];

  let finalEndDate = endDate;
  if (!finalEndDate || finalEndDate === '' || finalEndDate === null || finalEndDate === undefined) {
    const end = new Date(startDateObj.getFullYear(), startDateObj.getMonth() + 1, 0);
    finalEndDate = end.toISOString().split('T')[0];
  } else {
    const endDateObj = new Date(finalEndDate);
    if (isNaN(endDateObj.getTime())) {
      throw new Error('Invalid end date format. Expected YYYY-MM-DD format.');
    }
    finalEndDate = endDateObj.toISOString().split('T')[0];

    if (endDateObj < startDateObj) {
      throw new Error('End date must be after start date');
    }
  }

  const budgetAmount = parseFloat(monthlyBudget);
  if (isNaN(budgetAmount) || budgetAmount < 0) {
    throw new Error('Monthly budget must be a positive number');
  }

  const userIdNum = parseInt(userId);
  const budgetIdNum = parseInt(budgetId);
  if (isNaN(userIdNum) || userIdNum <= 0 || isNaN(budgetIdNum) || budgetIdNum <= 0) {
    throw new Error('Invalid user ID or budget ID');
  }

  try {
    const result = await pool.query(
      `UPDATE budgets 
       SET name = $1, monthly_budget = $2, start_date = $3, end_date = $4, 
           status = COALESCE($5, status), updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [
        name,
        budgetAmount,
        formattedStartDate,
        finalEndDate,
        status || 'active',
        budgetIdNum,
        userIdNum,
      ]
    );

    if (!result.rows || result.rows.length === 0) {
      throw new Error('Budget not found or you do not have permission to update it');
    }

    return result.rows[0];
  } catch (dbError) {
    console.error('Database error in updateBudget:', dbError);
    if (dbError.code) {
      throw new Error(
        `Database error: ${dbError.message || dbError.detail || 'Failed to update budget'}`
      );
    }
    throw dbError;
  }
}

export async function getBudgetStats(userId, clientDate = null) {
  try {
    const budget = await getActiveBudget(userId);
    if (!budget) {
      return null;
    }

    let startDateStr, endDateStr;
    if (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
      const [y, m] = clientDate.split('-').map(Number);
      startDateStr = `${y}-${String(m).padStart(2, '0')}-01`;
      endDateStr = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    } else {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      startDateStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      endDateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
    }

    const spentResult = await pool.query(
      `WITH from_clocked AS (
         SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
                SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as raw_hours,
                SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0)::numeric as pay_hours
         FROM time_entries te
         LEFT JOIN shifts s ON s.id = te.shift_id
         WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
           AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
           AND te.entry_type = 'clock_in_out' AND te.approved_at IS NOT NULL
         GROUP BY te.staff_id, te.date, te.shift_id, s.hours
       ),
       from_approved_shift AS (
         SELECT te.staff_id, te.date, te.shift_id, COALESCE(s.hours, 24)::numeric as shift_hours,
                (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
                CASE
                  WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                  ELSE LEAST(
                    (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                    COALESCE(s.hours, 24)::numeric
                  )
                END as pay_hours
         FROM time_entries te
         LEFT JOIN shifts s ON s.id = te.shift_id
         WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
           AND te.entry_type = 'approved_shift'
           AND NOT (te.shift_id IS NULL AND EXISTS (
             SELECT 1 FROM time_entries te2
             WHERE te2.staff_id = te.staff_id AND te2.date = te.date
               AND te2.entry_type = 'approved_shift' AND te2.shift_id IS NOT NULL
           ))
           AND NOT (te.shift_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM time_entries te2
             WHERE te2.staff_id = te.staff_id AND te2.date = te.date AND te2.shift_id = te.shift_id
               AND te2.entry_type = 'clock_in_out' AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
               AND te2.approved_at IS NOT NULL
           ))
       ),
       from_manual AS (
         SELECT te.staff_id, te.date, te.shift_id, 24::numeric as shift_hours,
                (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric) as raw_hours,
                CASE
                  WHEN COALESCE(te.leave_category, 'none') = 'unpaid_leave' THEN 0::numeric
                  ELSE LEAST(
                    (COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric),
                    24::numeric
                  )
                END as pay_hours
         FROM time_entries te
         WHERE te.user_id = $1 AND te.date >= $2 AND te.date <= $3
           AND te.entry_type = 'manual'
       ),
       combined AS (
         SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_clocked
         UNION ALL SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_approved_shift
         UNION ALL SELECT staff_id, date, shift_id, shift_hours, raw_hours, pay_hours FROM from_manual
       )
       SELECT COALESCE(SUM(c.pay_hours * st.hourly_rate), 0)::numeric(12,2) as total_spent
       FROM combined c
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
        endDate: budget.end_date,
      },
      currentMonth: {
        spent: totalSpent,
        remaining: remaining,
        percentageUsed: Math.min(100, Math.max(0, percentageUsed)),
        isOverBudget: totalSpent > monthlyBudget,
      },
    };
  } catch (error) {
    console.error('Error in getBudgetStats:', error);
    throw error; // Re-throw to be handled by the endpoint
  }
}
