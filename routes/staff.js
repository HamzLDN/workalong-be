import express from 'express';
import { pool } from '../lib/db.js';
import {
  findStaffByUsername,
  verifyStaffPassword,
  createStaffSession,
  deleteStaffSession,
} from '../services/staff-auth.js';
import {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  getStaffStats,
  getBudgets,
  validatePasswordToken,
  setPasswordWithToken,
  resetStaffPassword,
} from '../services/staff.js';
import { logStaffActivity, getPortalTeamActivities, logShiftActivity } from '../lib/activity.js';
import { sanitizeString } from '../lib/sanitize.js';
import {
  calculateEndTime,
  checkShiftConflict,
  createShift,
  deleteShift,
  getShifts,
  INVALID_STAFF_ID,
} from '../services/shifts.js';
import { requireAuth, requireStaffAuth } from '../middleware/auth.js';
import { checkGeofence } from '../lib/geofence.js';
import {
  mergePermissions,
  sanitizeManagerPermissions,
} from '../lib/managerPermissions.js';

const router = express.Router();

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const staff = await findStaffByUsername(username);
    if (!staff) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (staff.status !== 'active') {
      return res.status(403).json({ error: 'This staff account is not active' });
    }
    const isValid = await verifyStaffPassword(password, staff.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const { sessionId, expiresAt } = await createStaffSession(
      staff.id,
      req.ip,
      req.headers['user-agent']
    );
    res.cookie('staffSessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      message: 'Staff signed in successfully',
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        accessRole: staff.access_role || 'employee',
        companyName: staff.company_name,
      },
      session: { id: sessionId, expiresAt },
    });
  } catch (error) {
    console.error('Staff login error:', error);
    res.status(500).json({ error: 'An error occurred during staff login' });
  }
});

router.get('/auth/me', requireStaffAuth, async (req, res) => {
  try {
    const staffResult = await pool.query('SELECT user_id FROM staff WHERE id = $1', [req.staffId]);
    let latitude = null;
    let longitude = null;
    if (staffResult.rows.length > 0) {
      const userId = staffResult.rows[0].user_id;
      const userResult = await pool.query('SELECT latitude, longitude FROM users WHERE id = $1', [
        userId,
      ]);
      if (userResult.rows.length > 0) {
        latitude = userResult.rows[0].latitude;
        longitude = userResult.rows[0].longitude;
      }
    }
    res.json({
      staff: {
        id: req.staff.id,
        name: req.staff.name,
        email: req.staff.email,
        role: req.staff.role,
        accessRole: req.staff.accessRole,
        companyName: req.staff.companyName,
      },
      companyLocation: { latitude, longitude },
    });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

router.get('/portal/team', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const result = await pool.query(
      `SELECT s.id, s.name, s.lastname, s.role, s.access_role, s.status,
              s.employment_type, s.hourly_rate,
              d.name AS department_name, b.name AS branch_name
       FROM staff s
       LEFT JOIN departments d ON s.department_id = d.id
       LEFT JOIN branches b ON s.branch_id = b.id
       WHERE s.manager_id = $1 AND s.user_id = (SELECT user_id FROM staff WHERE id = $1)
       ORDER BY s.name`,
      [req.staffId]
    );
    const pendingEntries = await pool.query(
      `SELECT te.id, te.clock_in_time AS clock_in, te.clock_out_time AS clock_out, te.hours_worked,
              te.leave_category, te.notes, te.approved_at,
              s.name AS staff_name, s.lastname AS staff_lastname
       FROM time_entries te
       JOIN staff s ON te.staff_id = s.id
       WHERE s.manager_id = $1
         AND te.approved_at IS NULL
         AND te.clock_out_time IS NOT NULL
       ORDER BY te.clock_in_time DESC
       LIMIT 50`,
      [req.staffId]
    );
    res.json({ team: result.rows, pendingApprovals: pendingEntries.rows });
  } catch (error) {
    console.error('Portal team error:', error);
    res.status(500).json({ error: 'Failed to load portal data' });
  }
});

const OVERTIME_THRESHOLD_HOURS = 3 / 60;

router.get('/portal/time-entries', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);

    const category = String(req.query.category || 'all').toLowerCase();
    if (category === 'hours' && !perms.hours?.read) {
      return res.status(403).json({ error: 'Hours access not permitted' });
    }
    if (category === 'leave' && !perms.leave?.read) {
      return res.status(403).json({ error: 'Leave access not permitted' });
    }
    if (category === 'all' && !perms.hours?.read && !perms.leave?.read) {
      return res.status(403).json({ error: 'Hours or leave access required' });
    }

    let scopeSql = '';
    if (category === 'hours') {
      scopeSql = `AND (te.leave_category IS NULL OR te.leave_category NOT IN ('paid_leave', 'unpaid_leave', 'sick_leave'))`;
    } else if (category === 'leave') {
      scopeSql = `AND te.leave_category IN ('paid_leave', 'unpaid_leave', 'sick_leave')`;
    } else if (category === 'all') {
      if (perms.hours?.read && !perms.leave?.read) {
        scopeSql = `AND (te.leave_category IS NULL OR te.leave_category NOT IN ('paid_leave', 'unpaid_leave', 'sick_leave'))`;
      } else if (!perms.hours?.read && perms.leave?.read) {
        scopeSql = `AND te.leave_category IN ('paid_leave', 'unpaid_leave', 'sick_leave')`;
      }
    }

    const entries = await pool.query(
      `SELECT
         te.id,
         te.staff_id,
         te.date,
         te.clock_in_time,
         te.clock_out_time,
         te.hours_worked,
         te.overtime_hours,
         te.notes,
         te.leave_category,
         te.entry_type,
         te.approved_at,
         te.staff_approved_at,
         te.staff_approved_by,
         NULLIF(TRIM(CONCAT(sa.name, ' ', COALESCE(sa.lastname, ''))), '') AS staff_approved_by_name,
         te.shift_id,
         sh.hours          AS scheduled_hours,
         sh.start_time     AS scheduled_start,
         ROUND((te.hours_worked - COALESCE(sh.hours, te.hours_worked))::numeric, 4)
                           AS extra_hours,
         s.name            AS staff_name,
         s.lastname        AS staff_lastname,
         s.role            AS staff_role
       FROM time_entries te
       JOIN staff s ON te.staff_id = s.id
       LEFT JOIN staff sa ON sa.id = te.staff_approved_by
       LEFT JOIN shifts sh ON te.shift_id = sh.id
       WHERE s.manager_id = $1
         AND te.clock_out_time IS NOT NULL
         ${scopeSql}
       ORDER BY te.clock_in_time DESC
       LIMIT 200`,
      [req.staffId]
    );
    res.json({ entries: entries.rows, category: category === 'all' ? 'filtered' : category });
  } catch (error) {
    console.error('Portal time entries error:', error);
    res.status(500).json({ error: 'Failed to load time entries' });
  }
});

router.post('/portal/time-entries/:id/approve', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const entryId = parseInt(req.params.id, 10);
    if (isNaN(entryId)) return res.status(400).json({ error: 'Invalid entry ID' });

    const mode = req.body?.mode === 'scheduled_only' ? 'scheduled_only' : 'with_overtime';

    const check = await pool.query(
      `SELECT te.id, te.hours_worked, te.approved_at, te.staff_approved_at, te.clock_in_time, te.notes,
              sh.hours AS scheduled_hours
       FROM time_entries te
       JOIN staff s ON te.staff_id = s.id
       LEFT JOIN shifts sh ON te.shift_id = sh.id
       WHERE te.id = $1
         AND s.manager_id = $2
         AND te.clock_out_time IS NOT NULL`,
      [entryId, req.staffId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Time entry not found or not in your team' });
    }
    const entry = check.rows[0];
    if (entry.approved_at) {
      return res.status(400).json({ error: 'Already confirmed by head office' });
    }
    if (entry.staff_approved_at) {
      return res.status(400).json({
        error: 'Already submitted — awaiting head office confirmation',
      });
    }

    const extraHours =
      entry.scheduled_hours != null
        ? parseFloat(entry.hours_worked) - parseFloat(entry.scheduled_hours)
        : 0;
    if (entry.scheduled_hours != null && extraHours <= OVERTIME_THRESHOLD_HOURS) {
      return res.status(400).json({
        error: 'No overtime to approve — extra time does not exceed 3 minutes',
      });
    }

    const managerStaffId = req.staffId;

    if (mode === 'scheduled_only') {
      if (entry.scheduled_hours == null || parseFloat(entry.scheduled_hours) <= 0) {
        return res.status(400).json({
          error:
            'Cannot approve scheduled hours only — this entry has no shift length on file. Use “Approve with overtime” or link the shift.',
        });
      }
      if (!entry.clock_in_time) {
        return res.status(400).json({
          error: 'Cannot approve scheduled hours only — clock-in time is missing.',
        });
      }

      const scheduledH = parseFloat(entry.scheduled_hours);
      const noteLine = '[Portal] Approved for scheduled hours only (overtime not paid).';
      const existingNotes = entry.notes != null ? String(entry.notes).trim() : '';
      const newNotes = existingNotes ? `${existingNotes}\n${noteLine}` : noteLine;

      const updated = await pool.query(
        `UPDATE time_entries
         SET clock_out_time = clock_in_time + ('1 hour'::interval * $2::numeric),
             hours_worked = $2::numeric,
             overtime_hours = 0,
             staff_approved_at = NOW(),
             staff_approved_by = $3,
             notes = $4
         WHERE id = $1
         RETURNING id, approved_at, staff_approved_at, staff_approved_by, hours_worked, overtime_hours, clock_out_time, clock_in_time`,
        [entryId, scheduledH, managerStaffId, newNotes]
      );
      const row = updated.rows[0];
      const nm = await pool.query(
        `SELECT NULLIF(TRIM(CONCAT(name, ' ', COALESCE(lastname, ''))), '') AS staff_approved_by_name
         FROM staff WHERE id = $1`,
        [managerStaffId]
      );
      res.json({
        message: 'Recommendation recorded — scheduled hours only (awaiting head office)',
        mode: 'scheduled_only',
        entry: {
          ...row,
          staff_approved_by_name: nm.rows[0]?.staff_approved_by_name ?? null,
        },
      });
      return;
    }

    const updated = await pool.query(
      `UPDATE time_entries
       SET staff_approved_at = NOW(),
           staff_approved_by = $1
       WHERE id = $2
       RETURNING id, approved_at, staff_approved_at, staff_approved_by, hours_worked, overtime_hours, clock_out_time, clock_in_time`,
      [managerStaffId, entryId]
    );
    const row = updated.rows[0];
    const nm = await pool.query(
      `SELECT NULLIF(TRIM(CONCAT(name, ' ', COALESCE(lastname, ''))), '') AS staff_approved_by_name
       FROM staff WHERE id = $1`,
      [managerStaffId]
    );
    res.json({
      message: 'Recommendation recorded — awaiting head office confirmation',
      mode: 'with_overtime',
      entry: {
        ...row,
        staff_approved_by_name: nm.rows[0]?.staff_approved_by_name ?? null,
      },
    });
  } catch (error) {
    console.error('Portal approve time entry error:', error);
    res.status(500).json({ error: 'Failed to approve time entry' });
  }
});

router.get('/portal/permissions', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const result = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const stored = result.rows[0]?.manager_permissions || null;
    res.json({ permissions: mergePermissions(stored) });
  } catch (error) {
    console.error('Portal permissions error:', error);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
});

router.get('/portal/stats', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }

    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.overview.read) {
      return res.status(403).json({ error: 'Overview access not permitted' });
    }

    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [headcountRow, hoursRow, otPendingRow] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total FROM staff WHERE manager_id = $1 AND status = 'active'`,
        [req.staffId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(te.hours_worked), 0) AS hours_this_month
         FROM time_entries te
         JOIN staff s ON te.staff_id = s.id
         WHERE s.manager_id = $1 AND te.date >= $2`,
        [req.staffId, firstOfMonth]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE te.staff_approved_at IS NULL
               AND (te.hours_worked::numeric - COALESCE(sh.hours::numeric, te.hours_worked::numeric))
                     > ($2::numeric / 60)
           )::int AS pending_manager_recommendations,
           COUNT(*) FILTER (
             WHERE te.staff_approved_at IS NOT NULL
               AND (te.hours_worked::numeric - COALESCE(sh.hours::numeric, te.hours_worked::numeric))
                     > ($2::numeric / 60)
           )::int AS awaiting_head_office_confirmation
         FROM time_entries te
         JOIN staff s ON te.staff_id = s.id
         LEFT JOIN shifts sh ON te.shift_id = sh.id
         WHERE s.manager_id = $1
           AND te.clock_out_time IS NOT NULL
           AND te.approved_at IS NULL`,
        [req.staffId, 3]
      ),
    ]);

    const otRow = otPendingRow.rows[0] || {};
    const pendingMgr = parseInt(otRow.pending_manager_recommendations ?? 0, 10);
    const awaitingHq = parseInt(otRow.awaiting_head_office_confirmation ?? 0, 10);

    res.json({
      totalStaff: parseInt(headcountRow.rows[0]?.total ?? 0, 10),
      hoursThisMonth: parseFloat(hoursRow.rows[0]?.hours_this_month ?? 0),
      pendingManagerRecommendations: pendingMgr,
      awaitingHeadOfficeConfirmation: awaitingHq,
      pendingApprovals: pendingMgr,
    });
  } catch (error) {
    console.error('Portal stats error:', error);
    res.status(500).json({ error: 'Failed to load team stats' });
  }
});

router.get('/portal/budget', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.budget.read) {
      return res.status(403).json({ error: 'Budget access not permitted' });
    }

    const budgets = await getBudgets(req.staff.companyUserId);
    res.json({ budgets });
  } catch (error) {
    console.error('Portal budget error:', error);
    res.status(500).json({ error: 'Failed to load budget' });
  }
});

router.post('/portal/time-entries', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);

    const { staffId, date, hoursWorked, overtimeHours, leaveCategory, notes } = req.body;
    if (!staffId || !date || hoursWorked == null) {
      return res.status(400).json({ error: 'staffId, date, and hoursWorked are required' });
    }

    const leaveKinds = ['paid_leave', 'unpaid_leave', 'sick_leave'];
    const isLeaveEntry =
      leaveCategory && typeof leaveCategory === 'string' && leaveKinds.includes(leaveCategory);

    if (isLeaveEntry) {
      if (!perms.leave?.write) {
        return res.status(403).json({ error: 'Leave write access not permitted' });
      }
    } else {
      if (!perms.hours?.write) {
        return res.status(403).json({ error: 'Hours write access not permitted' });
      }
    }

    const staffCheck = await pool.query(
      `SELECT id FROM staff WHERE id = $1 AND manager_id = $2
         AND user_id = (SELECT user_id FROM staff WHERE id = $2)`,
      [staffId, req.staffId]
    );
    if (staffCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Staff member not in your team' });
    }

    const result = await pool.query(
      `INSERT INTO time_entries (staff_id, date, hours_worked, overtime_hours, leave_category, notes, entry_type, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', (SELECT user_id FROM staff WHERE id = $1))
       RETURNING *`,
      [staffId, date, hoursWorked, overtimeHours || 0, leaveCategory || null, notes || null]
    );
    res.status(201).json({ entry: result.rows[0] });
  } catch (error) {
    console.error('Portal create time entry error:', error);
    res.status(500).json({ error: 'Failed to create time entry' });
  }
});

router.delete('/portal/time-entries/:id', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);

    const entryId = parseInt(req.params.id, 10);
    if (isNaN(entryId)) return res.status(400).json({ error: 'Invalid entry ID' });

    const leaveKinds = ['paid_leave', 'unpaid_leave', 'sick_leave'];
    const rowCheck = await pool.query(
      `SELECT te.leave_category FROM time_entries te
       JOIN staff s ON te.staff_id = s.id
       WHERE te.id = $1 AND s.manager_id = $2 AND te.entry_type = 'manual'`,
      [entryId, req.staffId]
    );
    if (rowCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Manual time entry not found in your team' });
    }
    const cat = rowCheck.rows[0]?.leave_category;
    const isLeave = cat && typeof cat === 'string' && leaveKinds.includes(cat);

    if (isLeave) {
      if (!perms.leave?.delete) {
        return res.status(403).json({ error: 'Leave delete access not permitted' });
      }
    } else {
      if (!perms.hours?.delete) {
        return res.status(403).json({ error: 'Hours delete access not permitted' });
      }
    }

    await pool.query('DELETE FROM time_entries WHERE id = $1', [entryId]);
    res.json({ message: 'Time entry deleted' });
  } catch (error) {
    console.error('Portal delete time entry error:', error);
    res.status(500).json({ error: 'Failed to delete time entry' });
  }
});

router.get('/portal/shifts', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.schedule?.read) {
      return res.status(403).json({ error: 'Schedule access not permitted' });
    }
    const { startDate, endDate, status } = req.query;
    const filters = {};
    if (startDate) filters.startDate = String(startDate).split('T')[0];
    if (endDate) filters.endDate = String(endDate).split('T')[0];
    if (status) filters.status = String(status);
    const rawCn = req.query.clientNow;
    const rawTz = req.query.timezoneOffset;
    if (rawCn !== undefined && rawCn !== '') {
      const cn = parseInt(String(rawCn), 10);
      if (!Number.isNaN(cn)) filters.clientNow = cn;
    }
    if (rawTz !== undefined && rawTz !== '') {
      const tz = parseInt(String(rawTz), 10);
      if (!Number.isNaN(tz)) filters.timezoneOffset = tz;
    }
    filters.managerStaffId = req.staffId;

    const shifts = await getShifts(req.staff.companyUserId, filters);
    res.json({ shifts });
  } catch (error) {
    console.error('Portal shifts error:', error);
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

router.post('/portal/shifts', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.schedule?.write) {
      return res.status(403).json({ error: 'Schedule write access not permitted' });
    }

    const {
      staffId,
      shiftDate,
      startTime,
      hours,
      breakMinutes,
      shiftType,
      payType,
      location,
      notes,
    } = req.body || {};
    if (!staffId || !shiftDate || !startTime || hours === undefined || hours === null) {
      return res.status(400).json({ error: 'Staff ID, date, start time, and hours are required' });
    }

    const teamCheck = await pool.query(
      `SELECT id FROM staff
       WHERE id = $1 AND manager_id = $2 AND user_id = $3`,
      [parseInt(staffId, 10), req.staffId, req.staff.companyUserId]
    );
    if (teamCheck.rows.length === 0) {
      return res
        .status(403)
        .json({ error: 'You can only schedule shifts for your direct reports' });
    }

    const normalizedDate = String(shiftDate).split('T')[0];
    const shiftHours = parseFloat(hours) || 0;
    const calculatedEndTime = calculateEndTime(startTime, shiftHours);
    const conflictResult = await checkShiftConflict(
      req.staff.companyUserId,
      parseInt(staffId, 10),
      normalizedDate,
      startTime,
      calculatedEndTime
    );
    if (conflictResult.hasConflict) {
      const conflicts = conflictResult.conflictingShifts;
      const conflictTimes = conflicts.map((c) => `${c.start}-${c.end}`).join(', ');
      return res.status(409).json({
        error: `This shift conflicts with an existing shift. Conflicting time(s): ${conflictTimes}`,
        conflictingShifts: conflicts,
      });
    }

    const shift = await createShift(
      req.staff.companyUserId,
      {
        staffId: parseInt(staffId, 10),
        shiftDate: normalizedDate,
        startTime,
        hours: shiftHours,
        breakMinutes,
        shiftType,
        payType,
        location: location ? sanitizeString(location) : location,
        notes: notes ? sanitizeString(notes) : notes,
      },
      { createdByStaffId: req.staffId }
    );

    const nm = await pool.query(`SELECT name, lastname FROM staff WHERE id = $1`, [
      parseInt(staffId, 10),
    ]);
    const sn = nm.rows[0];
    const staffName = sn ? `${sn.name || ''} ${sn.lastname || ''}`.trim() : 'Staff';

    await logShiftActivity(
      req.staff.companyUserId,
      {
        shiftId: shift.id,
        staffName,
        date: normalizedDate,
        startTime,
        hours: shiftHours,
      },
      'created',
      `[Portal] Manager scheduled shift for ${staffName}`
    );

    res.status(201).json({ message: 'Shift created successfully', shift });
  } catch (error) {
    console.error('Portal create shift error:', error);
    if (error.message === INVALID_STAFF_ID) {
      return res.status(400).json({ error: 'Staff ID must be a positive integer' });
    }
    if (error.message && error.message.includes('does not belong to this user')) {
      return res.status(403).json({ error: 'Cannot create shift for this staff member' });
    }
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

router.delete('/portal/shifts/:id', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.schedule?.delete) {
      return res.status(403).json({ error: 'Schedule delete access not permitted' });
    }

    const shiftId = parseInt(req.params.id, 10);
    if (isNaN(shiftId)) return res.status(400).json({ error: 'Invalid shift ID' });

    const own = await pool.query(
      `SELECT s.id, s.shift_date, st.name AS staff_name, st.lastname AS staff_lastname
       FROM shifts s
       JOIN staff st ON s.staff_id = st.id
       WHERE s.id = $1 AND s.user_id = $2 AND st.manager_id = $3`,
      [shiftId, req.staff.companyUserId, req.staffId]
    );
    if (own.rows.length === 0) {
      return res.status(404).json({ error: 'Shift not found or not in your team' });
    }

    await deleteShift(shiftId, req.staff.companyUserId);

    const row = own.rows[0];
    const dStr =
      row.shift_date instanceof Date
        ? row.shift_date.toISOString().split('T')[0]
        : String(row.shift_date).split('T')[0];
    const staffLabel = `${row.staff_name || ''} ${row.staff_lastname || ''}`.trim();
    await logShiftActivity(
      req.staff.companyUserId,
      {
        shiftId,
        staffName: staffLabel || 'Staff',
        date: dStr,
        startTime: '',
        hours: 0,
      },
      'deleted',
      `[Portal] Manager removed shift for ${staffLabel} on ${dStr}`
    );

    res.json({ message: 'Shift deleted successfully' });
  } catch (error) {
    console.error('Portal delete shift error:', error);
    if (error.message === 'Shift not found or you do not have permission to delete it') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

router.get('/portal/audit', requireStaffAuth, async (req, res) => {
  try {
    if (!['manager', 'payroll_admin'].includes(req.staff.accessRole)) {
      return res.status(403).json({ error: 'Manager or payroll admin access required' });
    }
    const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.staff.companyUserId,
    ]);
    const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
    if (!perms.audit?.read) {
      return res.status(403).json({ error: 'Audit access not permitted' });
    }
    const limit = req.query.limit;
    const offset = req.query.offset;
    const entries = await getPortalTeamActivities(
      req.staff.companyUserId,
      req.staffId,
      limit,
      offset
    );
    res.json({ entries });
  } catch (error) {
    console.error('Portal audit error:', error);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

router.get('/manager-permissions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
      req.userId,
    ]);
    const stored = result.rows[0]?.manager_permissions || null;
    res.json({ permissions: mergePermissions(stored) });
  } catch (error) {
    console.error('Get manager permissions error:', error);
    res.status(500).json({ error: 'Failed to get permissions' });
  }
});

router.put('/manager-permissions', requireAuth, async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'permissions object is required' });
    }
    const sanitised = sanitizeManagerPermissions(permissions);
    await pool.query('UPDATE users SET manager_permissions = $1 WHERE id = $2', [
      JSON.stringify(sanitised),
      req.userId,
    ]);
    res.json({ permissions: mergePermissions(sanitised) });
  } catch (error) {
    console.error('Update manager permissions error:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

router.post('/auth/logout', requireStaffAuth, async (req, res) => {
  try {
    const sessionId =
      req.cookies.staffSessionId ||
      (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
    if (sessionId) await deleteStaffSession(sessionId);
    res.clearCookie('staffSessionId', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });
    res.json({ message: 'Staff signed out successfully' });
  } catch (error) {
    console.error('Staff logout error:', error);
    res.status(500).json({ error: 'An error occurred during staff logout' });
  }
});

router.get('/validate-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    const tokenData = await validatePasswordToken(token);
    if (!tokenData) {
      return res.status(400).json({ error: 'Invalid or expired token', valid: false });
    }
    res.json({ valid: true, username: tokenData.username, name: tokenData.name });
  } catch (error) {
    console.error('Validate token error:', error);
    res.status(500).json({ error: 'An error occurred while validating token' });
  }
});

router.post('/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const result = await setPasswordWithToken(token, password);
    res.json({
      message: 'Password set successfully. You can now log in with your username and new password.',
      username: result.username,
    });
  } catch (error) {
    console.error('Set password error:', error);
    if (error.message === 'Invalid or expired token') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'An error occurred while setting password' });
  }
});

router.post('/:id/reset-password', requireAuth, async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    if (isNaN(staffId)) return res.status(400).json({ error: 'Invalid staff ID' });
    await resetStaffPassword(staffId, req.userId);
    res.json({
      message:
        'Password reset email sent successfully. The staff member will receive an email with a link to set their new password.',
    });
  } catch (error) {
    console.error('Reset staff password error:', error);
    res.status(500).json({ error: error.message || 'Failed to reset staff password' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const staff = await getStaff(req.userId);
    res.json({ staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'Failed to get staff' });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const clientDate = req.query.clientDate || null;
    const stats = await getStaffStats(req.userId, clientDate);
    res.json(stats);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

router.post('/clock-in', requireStaffAuth, async (req, res) => {
  try {
    const staffId = req.staffId;
    const { latitude: staffLat, longitude: staffLon } = req.body;
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const geofenceResult = await checkGeofence(staffId, staffLat, staffLon);
    if (!geofenceResult.allowed) {
      return res.status(403).json({
        error: geofenceResult.error,
        requiresLocation: geofenceResult.requiresLocation || false,
        distance: geofenceResult.distance,
        radius: geofenceResult.radius,
      });
    }

    const existingEntry = await pool.query(
      `SELECT te.*, s.clocked_out_time as shift_clocked_out_time
       FROM time_entries te
       LEFT JOIN shifts s ON te.shift_id = s.id
       WHERE te.staff_id = $1 AND te.date = $2 AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NULL
       AND (s.id IS NULL OR s.clocked_out_time IS NULL)
       ORDER BY te.clock_in_time DESC LIMIT 1`,
      [staffId, today]
    );
    if (existingEntry.rows.length > 0) {
      const existingTimeEntry = existingEntry.rows[0];
      if (existingTimeEntry.shift_id) {
        const shiftResult = await pool.query(
          `SELECT id FROM shifts WHERE id = $1 AND staff_id = $2 AND shift_date = $3 AND status != 'cancelled'`,
          [existingTimeEntry.shift_id, staffId, today]
        );
        if (shiftResult.rows.length > 0) {
          await pool.query(
            `UPDATE shifts SET clocked_in_time = $1 WHERE id = $2 AND clocked_in_time IS NULL`,
            [existingTimeEntry.clock_in_time, existingTimeEntry.shift_id]
          );
        }
      } else {
        const shiftResult = await pool.query(
          `SELECT id FROM shifts WHERE staff_id = $1 AND shift_date = $2 AND status != 'cancelled' ORDER BY start_time ASC LIMIT 1`,
          [staffId, today]
        );
        if (shiftResult.rows.length > 0) {
          await pool.query(`UPDATE time_entries SET shift_id = $1 WHERE id = $2`, [
            shiftResult.rows[0].id,
            existingTimeEntry.id,
          ]);
        }
      }
      return res.status(400).json({ error: 'Already clocked in today. Please clock out first.' });
    }

    const staffResult = await pool.query('SELECT user_id FROM staff WHERE id = $1', [staffId]);
    if (staffResult.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const companyUserId = staffResult.rows[0].user_id;

    const allShiftsResult = await pool.query(
      `SELECT id, shift_date, start_time, hours, clocked_in_time
       FROM shifts WHERE staff_id = $1 AND shift_date = $2 AND status != 'cancelled'
       ORDER BY start_time ASC`,
      [staffId, today]
    );
    if (allShiftsResult.rows.length === 0) {
      return res.status(400).json({
        error: 'No shift scheduled for today. You can only clock in if you have a scheduled shift.',
        date: today,
      });
    }

    let shift = null;
    const validShifts = [];
    for (const s of allShiftsResult.rows) {
      const shiftDate =
        s.shift_date instanceof Date
          ? s.shift_date.toISOString().split('T')[0]
          : String(s.shift_date).split('T')[0];
      let shiftStartTime = String(s.start_time);
      const shiftHours = parseFloat(s.hours) || 0;
      let shiftEndTime = calculateEndTime(shiftStartTime, shiftHours);
      if (shiftStartTime.split(':').length === 2) shiftStartTime += ':00';
      if (shiftEndTime.split(':').length === 2) shiftEndTime += ':00';
      const shiftStartDateTime = new Date(`${shiftDate}T${shiftStartTime}.000Z`);
      let shiftEndDateTime = new Date(`${shiftDate}T${shiftEndTime}.000Z`);
      const isOvernight = shiftEndTime < shiftStartTime;
      if (isOvernight)
        shiftEndDateTime = new Date(shiftEndDateTime.getTime() + 24 * 60 * 60 * 1000);
      const earliestClockInTime = new Date(shiftStartDateTime.getTime() - 15 * 60 * 1000);
      const isTooEarly = now < earliestClockInTime;
      const isTooLate = now > shiftEndDateTime;
      if (!isTooEarly && !isTooLate) {
        validShifts.push({
          shift: s,
          shiftStartDateTime,
          shiftEndDateTime,
          earliestClockInTime,
          isOvernight,
          shiftDate,
          shiftStartTime,
          shiftEndTime,
        });
      }
    }

    if (validShifts.length === 0) {
      const endedShifts = allShiftsResult.rows.filter((s) => {
        const shiftDate =
          s.shift_date instanceof Date
            ? s.shift_date.toISOString().split('T')[0]
            : String(s.shift_date).split('T')[0];
        const shiftHours = parseFloat(s.hours) || 0;
        let shiftEndTime = calculateEndTime(String(s.start_time), shiftHours);
        if (shiftEndTime.split(':').length === 2) shiftEndTime += ':00';
        let shiftEndDateTime = new Date(`${shiftDate}T${shiftEndTime}.000Z`);
        if (shiftEndTime < String(s.start_time)) {
          shiftEndDateTime = new Date(shiftEndDateTime.getTime() + 24 * 60 * 60 * 1000);
        }
        return now > shiftEndDateTime && !s.clocked_in_time;
      });
      if (endedShifts.length > 0) {
        const firstEnded = endedShifts[0];
        const shiftDate =
          firstEnded.shift_date instanceof Date
            ? firstEnded.shift_date.toISOString().split('T')[0]
            : String(firstEnded.shift_date).split('T')[0];
        const shiftHours = parseFloat(firstEnded.hours) || 0;
        let shiftEndTime = calculateEndTime(String(firstEnded.start_time), shiftHours);
        if (shiftEndTime.split(':').length === 2) shiftEndTime += ':00';
        const isOvernight = shiftEndTime < String(firstEnded.start_time);
        return res.status(400).json({
          error: `Your shift has already ended. Shift end time was ${shiftEndTime}${isOvernight ? ' (next day)' : ''}.`,
          shiftEndTime,
          currentTime: now.toISOString(),
        });
      }
      return res.status(400).json({
        error: 'No valid shifts available for clock-in at this time.',
        currentTime: now.toISOString(),
      });
    }

    for (const vs of validShifts) {
      const inValidWindow = now >= vs.earliestClockInTime && now <= vs.shiftEndDateTime;
      if (inValidWindow && !vs.shift.clocked_in_time) {
        shift = vs.shift;
        break;
      }
      if (!shift && !vs.shift.clocked_in_time) shift = vs.shift;
    }
    if (!shift && validShifts.length > 0) {
      const alreadyClockedIn = validShifts.find((vs) => {
        const inValidWindow = now >= vs.earliestClockInTime && now <= vs.shiftEndDateTime;
        return vs.shift.clocked_in_time && inValidWindow;
      });
      if (alreadyClockedIn) shift = alreadyClockedIn.shift;
    }
    if (!shift && validShifts.length > 0) shift = validShifts[0].shift;

    const selectedValidShift = validShifts.find((vs) => vs.shift.id === shift.id);
    const shiftId = shift.id;

    const previousEntries = await pool.query(
      `SELECT id, clock_out_time FROM time_entries WHERE staff_id = $1 AND date = $2 AND shift_id = $3 ORDER BY clock_in_time DESC`,
      [staffId, today, shiftId]
    );
    if (previousEntries.rows.length > 0) {
      const entryIds = previousEntries.rows.map((e) => e.id);
      await pool.query(`DELETE FROM time_entries WHERE id = ANY($1::bigint[])`, [entryIds]);
    }

    const updateResult = await pool.query(
      `UPDATE shifts SET clocked_in_time = $1, clocked_out_time = NULL, clock_source = 'staff',
       status = CASE WHEN status = 'approved' THEN 'scheduled' ELSE status END, approved_at = NULL, approved_by = NULL
       WHERE id = $2 RETURNING id, clocked_in_time, clocked_out_time, status, approved_at, approved_by`,
      [now, shiftId]
    );
    if (updateResult.rowCount === 0) {
      return res.status(500).json({ error: 'Failed to update shift. Please contact support.' });
    }

    const result = await pool.query(
      `INSERT INTO time_entries (user_id, staff_id, date, clock_in_time, hours_worked, overtime_hours, entry_type, shift_id)
       VALUES ($1, $2, $3, $4, 0, 0, 'clock_in_out', $5) RETURNING *`,
      [companyUserId, staffId, today, now, shiftId]
    );
    res.json({
      message: 'Clocked in successfully',
      timeEntry: result.rows[0],
      clockInTime: now,
      shiftId,
    });
  } catch (error) {
    console.error('Clock in error:', error);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

router.post('/clock-out', requireStaffAuth, async (req, res) => {
  const staffId = req.staffId;
  const { latitude: staffLat, longitude: staffLon, lateReason } = req.body;
  const geofenceResult = await checkGeofence(staffId, staffLat, staffLon);
  if (!geofenceResult.allowed) {
    return res.status(403).json({
      error: geofenceResult.error,
      requiresLocation: geofenceResult.requiresLocation || false,
      distance: geofenceResult.distance,
      radius: geofenceResult.radius,
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const staffResult = await client.query('SELECT user_id FROM staff WHERE id = $1', [staffId]);
    if (staffResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const companyUserId = staffResult.rows[0].user_id;

    const shiftResult = await client.query(
      `SELECT id, hours, status, clocked_in_time, shift_date, start_time FROM shifts
       WHERE staff_id = $1 AND (shift_date = $2 OR shift_date = $3)
       AND clocked_in_time IS NOT NULL AND clocked_out_time IS NULL
       ORDER BY shift_date DESC, start_time ASC LIMIT 1`,
      [staffId, today, yesterdayStr]
    );

    if (shiftResult.rows.length === 0) {
      const entryResult = await client.query(
        `SELECT id, clock_in_time, date FROM time_entries
         WHERE staff_id = $1 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL
         AND date >= $2::date - INTERVAL '7 days'
         ORDER BY clock_in_time DESC LIMIT 1`,
        [staffId, today]
      );
      if (entryResult.rows.length > 0) {
        const entry = entryResult.rows[0];
        const clockInTime = new Date(entry.clock_in_time);
        const diffMs = now - clockInTime;
        const totalHoursWorked = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
        const fallbackNote = 'Shift was removed by manager; clocked out via fallback.';
        await client.query(
          `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2,
           notes = CASE WHEN notes IS NOT NULL AND TRIM(notes) != '' THEN notes || E'\n' || $3 ELSE $3 END WHERE id = $4`,
          [now, totalHoursWorked, fallbackNote, entry.id]
        );
        await client.query(
          `UPDATE time_entries SET clock_out_time = $1, hours_worked = EXTRACT(EPOCH FROM ($1::timestamptz - clock_in_time))/3600
           WHERE staff_id = $2 AND id != $3 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL AND date >= $4::date - INTERVAL '7 days'`,
          [now, staffId, entry.id, today]
        );
        await client.query('COMMIT');
        return res.json({
          message:
            'Clocked out successfully. (Note: Your shift was removed, but your hours have been recorded.)',
          timeEntry: { id: entry.id, clock_out_time: now, hours_worked: totalHoursWorked },
          clockInTime,
          clockOutTime: now,
          totalHoursWorked,
          regularHours: totalHoursWorked,
          overtimeHours: 0,
          shiftApproved: false,
          shiftId: null,
          shiftRemoved: true,
        });
      }
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active clock-in found. Please clock in first.' });
    }

    const shift = shiftResult.rows[0];
    const shiftId = shift.id;
    const clockInTime = new Date(shift.clocked_in_time);
    const clockOutTime = now;
    const diffMs = clockOutTime - clockInTime;
    const totalHoursWorked = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
    const scheduledHours = parseFloat(shift.hours) || 0;
    let regularHours = totalHoursWorked;
    let overtimeHours = 0;
    if (totalHoursWorked > scheduledHours) {
      regularHours = scheduledHours;
      overtimeHours = Math.round((totalHoursWorked - scheduledHours) * 100) / 100;
    }

    const sd = new Date(shift.shift_date);
    const [startH, startM] = (shift.start_time || '00:00').toString().split(':').map(Number);
    const scheduledEnd = new Date(sd);
    scheduledEnd.setHours(startH || 0, startM || 0, 0, 0);
    scheduledEnd.setTime(scheduledEnd.getTime() + (parseFloat(shift.hours) || 0) * 3600000);
    const lateByMs = clockOutTime - scheduledEnd;
    const isLateOver10Mins = lateByMs > 10 * 60 * 1000;

    let notesForEntry = null;
    if (isLateOver10Mins) {
      const reason = typeof lateReason === 'string' ? lateReason.trim() : '';
      if (!reason) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'You clocked out more than 10 minutes late. Please provide a reason.',
          requiresLateReason: true,
        });
      }
      notesForEntry = `Late clock-out reason: ${reason}`;
    }

    const updateShiftResult = await client.query(
      `UPDATE shifts SET clocked_out_time = $1, status = 'review_hours', approved_at = NULL, approved_by = NULL
       WHERE id = $2 RETURNING id, status, clocked_out_time, approved_at`,
      [clockOutTime, shiftId]
    );
    if (updateShiftResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Failed to update shift' });
    }

    const shiftDateStr =
      shift.shift_date instanceof Date
        ? shift.shift_date.toISOString().split('T')[0]
        : typeof shift.shift_date === 'string'
          ? shift.shift_date.split('T')[0]
          : shift.shift_date;
    let entryResult = await client.query(
      `SELECT * FROM time_entries WHERE staff_id = $1 AND (date = $2 OR date = $3) AND shift_id = $4 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL ORDER BY clock_in_time DESC LIMIT 1`,
      [staffId, today, shiftDateStr, shiftId]
    );
    if (entryResult.rows.length === 0) {
      entryResult = await client.query(
        `SELECT * FROM time_entries WHERE staff_id = $1 AND (date = $2 OR date = $3) AND (shift_id IS NULL OR shift_id = $4) AND clock_in_time IS NOT NULL AND clock_out_time IS NULL ORDER BY clock_in_time DESC LIMIT 1`,
        [staffId, today, shiftDateStr, shiftId]
      );
    }
    let updateResult = null;
    let timeEntryId = null;
    if (entryResult.rows.length > 0) {
      const entryId = entryResult.rows[0].id;
      const updateEntryResult = notesForEntry
        ? await client.query(
            `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2, overtime_hours = $3, shift_id = $5, notes = $6 WHERE id = $4 RETURNING *`,
            [clockOutTime, totalHoursWorked, overtimeHours, entryId, shiftId, notesForEntry]
          )
        : await client.query(
            `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2, overtime_hours = $3, shift_id = $5 WHERE id = $4 RETURNING *`,
            [clockOutTime, totalHoursWorked, overtimeHours, entryId, shiftId]
          );
      updateResult = updateEntryResult.rows[0];
      timeEntryId = updateEntryResult.rows[0].id;
      await client.query('UPDATE shifts SET time_entry_id = $1 WHERE id = $2', [
        timeEntryId,
        shiftId,
      ]);
    }
    await client.query(
      `UPDATE time_entries SET clock_out_time = $1, hours_worked = EXTRACT(EPOCH FROM ($1::timestamptz - clock_in_time))/3600
       WHERE staff_id = $2 AND date >= $3::date - INTERVAL '1 day' AND date <= $3::date AND clock_in_time IS NOT NULL AND clock_out_time IS NULL`,
      [clockOutTime, staffId, today]
    );

    await client.query('COMMIT');
    res.json({
      message: isLateOver10Mins
        ? 'Clocked out successfully. Your hours have been marked for review due to late clock-out.'
        : 'Clocked out successfully. Pending manager approval.',
      timeEntry: updateResult,
      clockInTime,
      clockOutTime,
      totalHoursWorked,
      regularHours,
      overtimeHours,
      shiftApproved: false,
      shiftId,
      status: 'review_hours',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Clock-out error:', error);
    res.status(500).json({ error: 'Failed to clock out' });
  } finally {
    client.release();
  }
});

router.get('/my-shifts', requireStaffAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = 'SELECT s.* FROM shifts s WHERE s.staff_id = $1';
    const params = [req.staffId];
    if (startDate) {
      query += ` AND s.shift_date >= $${params.length + 1}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND s.shift_date <= $${params.length + 1}`;
      params.push(endDate);
    }
    query += ' ORDER BY s.shift_date DESC, s.start_time ASC';
    const result = await pool.query(query, params);
    res.json({ shifts: result.rows });
  } catch (error) {
    console.error('Get my shifts error:', error);
    res.status(500).json({ error: 'Failed to get shifts' });
  }
});

router.get('/my-time-entries', requireStaffAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = 'SELECT te.* FROM time_entries te WHERE te.staff_id = $1';
    const params = [req.staffId];
    if (startDate) {
      query += ` AND te.date >= $${params.length + 1}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND te.date <= $${params.length + 1}`;
      params.push(endDate);
    }
    query += ' ORDER BY te.date DESC, te.clock_in_time DESC';
    const result = await pool.query(query, params);
    res.json({ timeEntries: result.rows });
  } catch (error) {
    console.error('Get my time entries error:', error);
    res.status(500).json({ error: 'Failed to get time entries' });
  }
});

router.get('/clock-status', requireStaffAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT te.* FROM time_entries te LEFT JOIN shifts s ON te.shift_id = s.id
       WHERE te.staff_id = $1 AND te.date = $2 AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NULL
       AND (s.id IS NULL OR s.clocked_out_time IS NULL) ORDER BY te.clock_in_time DESC LIMIT 1`,
      [req.staffId, today]
    );
    if (result.rows.length === 0) return res.json({ clockedIn: false });
    res.json({
      clockedIn: true,
      timeEntry: result.rows[0],
      clockInTime: result.rows[0].clock_in_time,
    });
  } catch (error) {
    console.error('Get clock status error:', error);
    res.status(500).json({ error: 'Failed to get clock status' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const staff = await getStaffById(req.params.id, req.userId);
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'Failed to get staff member' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      name,
      email,
      role,
      hourlyRate,
      employmentType,
      departmentId,
      branchId,
      managerId,
      accessRole,
    } = req.body;
    if (!name || !role || !hourlyRate) {
      return res.status(400).json({ error: 'Name, role, and hourly rate are required' });
    }
    if (hourlyRate < 0) {
      return res.status(400).json({ error: 'Hourly rate must be positive' });
    }
    const [subResult, countResult] = await Promise.all([
      pool.query('SELECT subscription_status, subscription_staff_limit FROM users WHERE id = $1', [
        req.userId,
      ]),
      pool.query('SELECT COUNT(*) FROM staff WHERE user_id = $1', [req.userId]),
    ]);
    const currentCount = parseInt(countResult.rows[0].count, 10);
    const sub = subResult.rows[0];
    const isPaid = sub?.subscription_status === 'paid' || sub?.subscription_status === 'trial';
    const staffLimit =
      sub?.subscription_staff_limit != null ? parseInt(sub.subscription_staff_limit, 10) : null;
    if (!isPaid && currentCount >= 3) {
      return res.status(403).json({
        error: 'Free plan limited to 3 staff members. Upgrade to Professional for more.',
        code: 'SUBSCRIPTION_REQUIRED',
        upgradeUrl: '/plans',
      });
    }
    if (isPaid && staffLimit != null && currentCount >= staffLimit) {
      return res.status(403).json({
        error: `Your plan allows up to ${staffLimit} staff. Visit Plans to increase your limit.`,
        code: 'STAFF_LIMIT_REACHED',
        upgradeUrl: '/plans',
      });
    }
    const staff = await createStaff(req.userId, {
      name,
      email,
      role,
      hourlyRate,
      employmentType,
      departmentId,
      branchId,
      managerId,
      accessRole,
    });
    logStaffActivity(req.userId, staff.id, name, 'created').catch((err) =>
      console.error('Failed to log activity:', err)
    );
    const { password_hash, ...staffWithoutHash } = staff;
    res.status(201).json({
      message:
        'Staff member created successfully. A password setup email has been sent to their email address.',
      staff: { ...staffWithoutHash, username: staff.username },
    });
  } catch (error) {
    console.error('Create staff error:', error);
    if (
      error.message?.includes('not found') ||
      error.message?.includes('Invalid') ||
      error.message?.includes('cannot manage')
    ) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const staffId = req.params.id;
    const staff = await pool.query('SELECT * FROM staff WHERE id = $1 AND user_id = $2', [
      staffId,
      req.userId,
    ]);
    if (staff.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    const staffName = staff.rows[0].name;
    await pool.query('DELETE FROM staff WHERE id = $1', [staffId]);
    logStaffActivity(req.userId, staffId, staffName, 'deleted').catch((err) =>
      console.error('Failed to log activity:', err)
    );
    res.json({ message: 'Staff member deleted successfully', id: staffId });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      name,
      email,
      role,
      hourlyRate,
      employmentType,
      status,
      departmentId,
      branchId,
      managerId,
      accessRole,
      assignmentReason,
    } = req.body;
    const staff = await updateStaff(req.params.id, req.userId, {
      name,
      email,
      role,
      hourlyRate,
      employmentType,
      status,
      departmentId,
      branchId,
      managerId,
      accessRole,
      assignmentReason,
    });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    logStaffActivity(req.userId, req.params.id, name, 'updated').catch((err) =>
      console.error('Failed to log activity:', err)
    );
    res.json({ message: 'Staff member updated successfully', staff });
  } catch (error) {
    console.error('Update staff error:', error);
    if (
      error.message?.includes('not found') ||
      error.message?.includes('Invalid') ||
      error.message?.includes('cannot manage')
    ) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

export default router;
