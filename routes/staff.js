import express from 'express';
import { pool } from '../lib/db.js';
import {
  findStaffByUsername,
  verifyStaffPassword,
  createStaffSession,
  deleteStaffSession
} from '../services/staff-auth.js';
import {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  getStaffStats,
  validatePasswordToken,
  setPasswordWithToken,
  resetStaffPassword
} from '../services/staff.js';
import { logStaffActivity } from '../lib/activity.js';
import { requireAuth, requireStaffAuth } from '../middleware/auth.js';
import { checkGeofence } from '../lib/geofence.js';
import { calculateEndTime } from '../services/shifts.js';

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
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({
      message: 'Staff signed in successfully',
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        companyName: staff.company_name
      },
      session: { id: sessionId, expiresAt }
    });
  } catch (error) {
    console.error('Staff login error:', error);
    res.status(500).json({ error: 'An error occurred during staff login' });
  }
});

router.get('/auth/me', requireStaffAuth, async (req, res) => {
  try {
    const staffResult = await pool.query(
      'SELECT user_id FROM staff WHERE id = $1',
      [req.staffId]
    );
    let latitude = null;
    let longitude = null;
    if (staffResult.rows.length > 0) {
      const userId = staffResult.rows[0].user_id;
      const userResult = await pool.query(
        'SELECT latitude, longitude FROM users WHERE id = $1',
        [userId]
      );
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
        companyName: req.staff.companyName
      },
      companyLocation: { latitude, longitude }
    });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

router.post('/auth/logout', requireStaffAuth, async (req, res) => {
  try {
    const sessionId = req.cookies.staffSessionId ||
      (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
    if (sessionId) await deleteStaffSession(sessionId);
    res.clearCookie('staffSessionId', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
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
      username: result.username
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
      message: 'Password reset email sent successfully. The staff member will receive an email with a link to set their new password.'
    });
  } catch (error) {
    console.error('Reset staff password error:', error);
    res.status(500).json({ error: error.message || 'Failed to reset staff password' });
  }
});

// ----- List & stats -----
/**
 * @swagger
 * /staff:
 *   get:
 *     summary: Get all staff members
 *     description: Retrieve a list of all staff members for the authenticated user
 *     tags: [Staff]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of staff members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 staff:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Staff'
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
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

// ----- Clock-in (long handler) -----
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
        radius: geofenceResult.radius
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
          await pool.query(
            `UPDATE time_entries SET shift_id = $1 WHERE id = $2`,
            [shiftResult.rows[0].id, existingTimeEntry.id]
          );
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
        date: today
      });
    }

    let shift = null;
    const validShifts = [];
    for (const s of allShiftsResult.rows) {
      const shiftDate = s.shift_date instanceof Date ? s.shift_date.toISOString().split('T')[0] : String(s.shift_date).split('T')[0];
      let shiftStartTime = String(s.start_time);
      const shiftHours = parseFloat(s.hours) || 0;
      let shiftEndTime = calculateEndTime(shiftStartTime, shiftHours);
      if (shiftStartTime.split(':').length === 2) shiftStartTime += ':00';
      if (shiftEndTime.split(':').length === 2) shiftEndTime += ':00';
      const shiftStartDateTime = new Date(`${shiftDate}T${shiftStartTime}.000Z`);
      let shiftEndDateTime = new Date(`${shiftDate}T${shiftEndTime}.000Z`);
      const isOvernight = shiftEndTime < shiftStartTime;
      if (isOvernight) shiftEndDateTime = new Date(shiftEndDateTime.getTime() + 24 * 60 * 60 * 1000);
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
          shiftEndTime
        });
      }
    }

    if (validShifts.length === 0) {
      const endedShifts = allShiftsResult.rows.filter(s => {
        const shiftDate = s.shift_date instanceof Date ? s.shift_date.toISOString().split('T')[0] : String(s.shift_date).split('T')[0];
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
        const shiftDate = firstEnded.shift_date instanceof Date ? firstEnded.shift_date.toISOString().split('T')[0] : String(firstEnded.shift_date).split('T')[0];
        const shiftHours = parseFloat(firstEnded.hours) || 0;
        let shiftEndTime = calculateEndTime(String(firstEnded.start_time), shiftHours);
        if (shiftEndTime.split(':').length === 2) shiftEndTime += ':00';
        const isOvernight = shiftEndTime < String(firstEnded.start_time);
        return res.status(400).json({
          error: `Your shift has already ended. Shift end time was ${shiftEndTime}${isOvernight ? ' (next day)' : ''}.`,
          shiftEndTime,
          currentTime: now.toISOString()
        });
      }
      return res.status(400).json({
        error: 'No valid shifts available for clock-in at this time.',
        currentTime: now.toISOString()
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
      const alreadyClockedIn = validShifts.find(vs => {
        const inValidWindow = now >= vs.earliestClockInTime && now <= vs.shiftEndDateTime;
        return vs.shift.clocked_in_time && inValidWindow;
      });
      if (alreadyClockedIn) shift = alreadyClockedIn.shift;
    }
    if (!shift && validShifts.length > 0) shift = validShifts[0].shift;

    const selectedValidShift = validShifts.find(vs => vs.shift.id === shift.id);
    const shiftId = shift.id;

    const previousEntries = await pool.query(
      `SELECT id, clock_out_time FROM time_entries WHERE staff_id = $1 AND date = $2 AND shift_id = $3 ORDER BY clock_in_time DESC`,
      [staffId, today, shiftId]
    );
    if (previousEntries.rows.length > 0) {
      const entryIds = previousEntries.rows.map(e => e.id);
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
      shiftId
    });
  } catch (error) {
    console.error('Clock in error:', error);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// ----- Clock-out -----
router.post('/clock-out', requireStaffAuth, async (req, res) => {
  const staffId = req.staffId;
  const { latitude: staffLat, longitude: staffLon, lateReason } = req.body;
  const geofenceResult = await checkGeofence(staffId, staffLat, staffLon);
  if (!geofenceResult.allowed) {
    return res.status(403).json({
      error: geofenceResult.error,
      requiresLocation: geofenceResult.requiresLocation || false,
      distance: geofenceResult.distance,
      radius: geofenceResult.radius
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

    // Fallback: if shift was deleted by manager, clock out via time_entry only
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
          message: 'Clocked out successfully. (Note: Your shift was removed, but your hours have been recorded.)',
          timeEntry: { id: entry.id, clock_out_time: now, hours_worked: totalHoursWorked },
          clockInTime,
          clockOutTime: now,
          totalHoursWorked,
          regularHours: totalHoursWorked,
          overtimeHours: 0,
          shiftApproved: false,
          shiftId: null,
          shiftRemoved: true
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

    // Compute scheduled end: shift_date + start_time + hours
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
          requiresLateReason: true
        });
      }
      notesForEntry = `Late clock-out reason: ${reason}`;
    }

    // Always require manager approval - no auto-approve on clock-out
    const updateShiftResult = await client.query(
      `UPDATE shifts SET clocked_out_time = $1, status = 'review_hours', approved_at = NULL, approved_by = NULL
       WHERE id = $2 RETURNING id, status, clocked_out_time, approved_at`,
      [clockOutTime, shiftId]
    );
    if (updateShiftResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Failed to update shift' });
    }

    const shiftDateStr = shift.shift_date instanceof Date ? shift.shift_date.toISOString().split('T')[0] : (typeof shift.shift_date === 'string' ? shift.shift_date.split('T')[0] : shift.shift_date);
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
      await client.query('UPDATE shifts SET time_entry_id = $1 WHERE id = $2', [timeEntryId, shiftId]);
    }
    // Close other open entries - today and yesterday only (covers overnight; avoids overwriting entries from 2+ days ago)
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
      status: 'review_hours'
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
    if (startDate) { query += ` AND s.shift_date >= $${params.length + 1}`; params.push(startDate); }
    if (endDate) { query += ` AND s.shift_date <= $${params.length + 1}`; params.push(endDate); }
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
    if (startDate) { query += ` AND te.date >= $${params.length + 1}`; params.push(startDate); }
    if (endDate) { query += ` AND te.date <= $${params.length + 1}`; params.push(endDate); }
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
    res.json({ clockedIn: true, timeEntry: result.rows[0], clockInTime: result.rows[0].clock_in_time });
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

/**
 * @swagger
 * /staff:
 *   post:
 *     summary: Create a new staff member
 *     description: Create a new staff member for the authenticated user. A password setup email will be sent to the staff member's email address.
 *     tags: [Staff]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - role
 *               - hourlyRate
 *             properties:
 *               name:
 *                 type: string
 *                 example: "John Doe"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "john@example.com"
 *               role:
 *                 type: string
 *                 example: "Manager"
 *               hourlyRate:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 example: 15.50
 *               employmentType:
 *                 type: string
 *                 example: "full-time"
 *     responses:
 *       201:
 *         description: Staff member created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 staff:
 *                   $ref: '#/components/schemas/Staff'
 *       400:
 *         description: Bad request (missing required fields or invalid hourly rate)
 *       403:
 *         description: Staff limit reached (subscription limit)
 *       500:
 *         description: Server error
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, email, role, hourlyRate, employmentType } = req.body;
    if (!name || !role || !hourlyRate) {
      return res.status(400).json({ error: 'Name, role, and hourly rate are required' });
    }
    if (hourlyRate < 0) {
      return res.status(400).json({ error: 'Hourly rate must be positive' });
    }
    const [subResult, countResult] = await Promise.all([
      pool.query('SELECT subscription_status, subscription_staff_limit FROM users WHERE id = $1', [req.userId]),
      pool.query('SELECT COUNT(*) FROM staff WHERE user_id = $1', [req.userId])
    ]);
    const currentCount = parseInt(countResult.rows[0].count, 10);
    const sub = subResult.rows[0];
    const isPaid = sub?.subscription_status === 'paid' || sub?.subscription_status === 'trial';
    const staffLimit = sub?.subscription_staff_limit != null ? parseInt(sub.subscription_staff_limit, 10) : null;
    if (!isPaid && currentCount >= 3) {
      return res.status(403).json({
        error: 'Free plan limited to 3 staff members. Upgrade to Professional for more.',
        code: 'SUBSCRIPTION_REQUIRED',
        upgradeUrl: '/plans'
      });
    }
    if (isPaid && staffLimit != null && currentCount >= staffLimit) {
      return res.status(403).json({
        error: `Your plan allows up to ${staffLimit} staff. Visit Plans to increase your limit.`,
        code: 'STAFF_LIMIT_REACHED',
        upgradeUrl: '/plans'
      });
    }
    const staff = await createStaff(req.userId, { name, email, role, hourlyRate, employmentType });
    logStaffActivity(req.userId, staff.id, name, 'created').catch(err => console.error('Failed to log activity:', err));
    const { password_hash, ...staffWithoutHash } = staff;
    res.status(201).json({
      message: 'Staff member created successfully. A password setup email has been sent to their email address.',
      staff: { ...staffWithoutHash, username: staff.username }
    });
  } catch (error) {
    console.error('Create staff error:', error);
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const staffId = req.params.id;
    const staff = await pool.query('SELECT * FROM staff WHERE id = $1 AND user_id = $2', [staffId, req.userId]);
    if (staff.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    const staffName = staff.rows[0].name;
    await pool.query('DELETE FROM staff WHERE id = $1', [staffId]);
    logStaffActivity(req.userId, staffId, staffName, 'deleted').catch(err => console.error('Failed to log activity:', err));
    res.json({ message: 'Staff member deleted successfully', id: staffId });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, email, role, hourlyRate, employmentType, status } = req.body;
    const staff = await updateStaff(req.params.id, req.userId, { name, email, role, hourlyRate, employmentType, status });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    logStaffActivity(req.userId, req.params.id, name, 'updated').catch(err => console.error('Failed to log activity:', err));
    res.json({ message: 'Staff member updated successfully', staff });
  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

export default router;
