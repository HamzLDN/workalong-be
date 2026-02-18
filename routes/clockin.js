import crypto from 'crypto';
import express from 'express';
import { pool } from '../lib/db.js';
import { config } from '../lib/config.js';
import { requireAuth } from '../middleware/auth.js';
import { checkGeofence } from '../lib/geofence.js';

const router = express.Router();
const isDev = process.env.NODE_ENV !== 'production';

router.post('/generate-link', requireAuth, async (req, res) => {
  try {
    const { deviceName, expiresInDays } = req.body;
    const linkToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays || 90));
    const linkResult = await pool.query(
      `INSERT INTO device_links (user_id, staff_id, link_token, device_name, expires_at)
       VALUES ($1, NULL, $2, $3, $4)
       RETURNING id, link_token, expires_at, created_at`,
      [req.userId, linkToken, deviceName || null, expiresAt]
    );
    const link = linkResult.rows[0];
    const baseUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';
    const clockinUrl = `${baseUrl}/clockin/${linkToken}`;
    res.json({
      message: 'Device link generated successfully',
      link: {
        id: link.id,
        token: link.link_token,
        url: clockinUrl,
        expiresAt: link.expires_at,
        createdAt: link.created_at,
        deviceName: deviceName || null
      }
    });
  } catch (error) {
    console.error('Generate device link error:', error);
    res.status(500).json({ error: 'Failed to generate device link' });
  }
});

router.get('/links', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dl.* FROM device_links dl WHERE dl.user_id = $1 ORDER BY dl.created_at DESC`,
      [req.userId]
    );
    const baseUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';
    const links = result.rows.map(link => ({
      id: link.id,
      token: link.link_token,
      url: `${baseUrl}/clockin/${link.link_token}`,
      deviceName: link.device_name,
      deviceFingerprint: link.device_fingerprint ? 'Set' : 'Pending',
      isActive: link.is_active,
      createdAt: link.created_at,
      expiresAt: link.expires_at,
      lastUsedAt: link.last_used_at
    }));
    res.json({ links });
  } catch (error) {
    console.error('Get device links error:', error);
    res.status(500).json({ error: 'Failed to get device links' });
  }
});

router.delete('/links/:linkId', requireAuth, async (req, res) => {
  try {
    const { linkId } = req.params;
    const result = await pool.query(
      'DELETE FROM device_links WHERE id = $1 AND user_id = $2 RETURNING id',
      [linkId, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Device link not found' });
    res.json({ message: 'Device link revoked successfully' });
  } catch (error) {
    console.error('Revoke device link error:', error);
    res.status(500).json({ error: 'Failed to revoke device link' });
  }
});

router.get('/verify-link/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const deviceFingerprint = req.headers['x-device-fingerprint'] || req.query.fingerprint;
    if (!deviceFingerprint) {
      return res.status(400).json({ error: 'Device fingerprint is required', requiresFingerprint: true });
    }
    const linkResult = await pool.query(
      `SELECT dl.* FROM device_links dl WHERE dl.link_token = $1 AND dl.is_active = TRUE`,
      [token]
    );
    if (linkResult.rows.length === 0) return res.status(404).json({ error: 'Invalid or inactive link' });
    const link = linkResult.rows[0];
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Link has expired' });
    }
    if (link.device_fingerprint) {
      if (link.device_fingerprint !== deviceFingerprint) {
        return res.status(403).json({ error: 'This link is locked to a different device', lockedDevice: true });
      }
    } else {
      await pool.query(
        'UPDATE device_links SET device_fingerprint = $1, last_used_at = NOW() WHERE id = $2',
        [deviceFingerprint, link.id]
      );
    }
    await pool.query('UPDATE device_links SET last_used_at = NOW() WHERE id = $1', [link.id]);
    res.json({ valid: true, deviceName: link.device_name });
  } catch (error) {
    console.error('Verify device link error:', error);
    res.status(500).json({ error: 'Failed to verify device link' });
  }
});

router.post('/clock-action', async (req, res) => {
  try {
    const { clockinId, action, linkToken, latitude, longitude } = req.body;
    const deviceFingerprint = req.headers['x-device-fingerprint'] || req.body.deviceFingerprint;
    if (!clockinId || !action || !linkToken) {
      return res.status(400).json({ error: 'Clock-in code (or username), action, and link token are required' });
    }
    if (!deviceFingerprint) return res.status(400).json({ error: 'Device fingerprint is required' });

    const raw = String(clockinId || '').trim();
    // Extract last 6 digits from input - works for "411125", "dan.411125", "dansmith411125", etc.
    const digits = raw.replace(/\D/g, '');
    const code = digits.slice(-6);
    if (code.length !== 6) {
      return res.status(400).json({ error: 'Enter your 6-digit clock-in code or username (e.g. dan.411125 – we use the last 6 digits)' });
    }

    const linkResult = await pool.query(
      `SELECT dl.* FROM device_links dl WHERE dl.link_token = $1 AND dl.is_active = TRUE`,
      [linkToken]
    );
    if (linkResult.rows.length === 0) return res.status(404).json({ error: 'Invalid or inactive link' });
    const link = linkResult.rows[0];
    if (link.device_fingerprint && link.device_fingerprint !== deviceFingerprint) {
      return res.status(403).json({ error: 'Device fingerprint mismatch' });
    }
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Link has expired' });
    }

    // Lookup staff by: 1) clockin_id (if column exists), 2) exact username, 3) last 6 chars of username, 4) last 6 digits from username
    let staffResult = await pool.query(
      `SELECT s.id as staff_id, s.name as staff_name, s.user_id FROM staff s
       WHERE s.user_id = $1 AND s.username IS NOT NULL AND RIGHT(TRIM(s.username), 6) = $2`,
      [String(link.user_id), code]
    );
    if (staffResult.rows.length === 0) {
      staffResult = await pool.query(
        `SELECT s.id as staff_id, s.name as staff_name, s.user_id FROM staff s
         WHERE s.user_id = $1 AND s.username IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(TRIM(s.username), '[^0-9]', '', 'g'), 6) = $2`,
        [String(link.user_id), code]
      );
    }
    if (staffResult.rows.length === 0 && raw !== code) {
      staffResult = await pool.query(
        `SELECT s.id as staff_id, s.name as staff_name, s.user_id FROM staff s
         WHERE s.username = $1 AND s.user_id = $2`,
        [raw, link.user_id]
      );
    }
    if (staffResult.rows.length === 0) {
      staffResult = await pool.query(
        `SELECT s.id as staff_id, s.name as staff_name, s.user_id FROM staff s
         WHERE s.user_id = $1 AND s.username IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(TRIM(s.username), '[^0-9]', '', 'g'), 6) = $2`,
        [String(link.user_id), code]
      );
    }
    if (staffResult.rows.length === 0) {
      const dbName = config.db?.database || process.env.DB_NAME || 'unknown';
      console.log(
        `[clock-action] Staff not found: db=${dbName}, linkUserId=${link.user_id} (type: ${typeof link.user_id}), code="${code}", raw="${raw}"`
      );
      return res.status(403).json({
        error: 'Invalid clock-in ID or staff member not found'
      });
    }
    const staffId = staffResult.rows[0].staff_id;

    if (action === 'clock-in') {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      // Only enforce geofence when valid coordinates are provided (skip for desktop/kiosk without location)
      const hasValidLocation = typeof latitude === 'number' && typeof longitude === 'number';
      if (hasValidLocation) {
        const geofenceResult = await checkGeofence(staffId, latitude, longitude);
        if (!geofenceResult.allowed) {
          return res.status(403).json({
            error: geofenceResult.error,
            requiresLocation: geofenceResult.requiresLocation || false,
            distance: geofenceResult.distance,
            radius: geofenceResult.radius
          });
        }
      }
      const existingEntry = await pool.query(
        `SELECT te.*, s.clocked_out_time as shift_clocked_out_time FROM time_entries te
         LEFT JOIN shifts s ON te.shift_id = s.id
         WHERE te.staff_id = $1 AND te.date = $2 AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NULL
         AND (s.id IS NULL OR s.clocked_out_time IS NULL) ORDER BY te.clock_in_time DESC LIMIT 1`,
        [staffId, today]
      );
      if (existingEntry.rows.length > 0) {
        return res.status(400).json({ error: 'Already clocked in today. Please clock out first.' });
      }
      const shiftResult = await pool.query(
        `SELECT id, shift_date, start_time, hours, clocked_in_time FROM shifts
         WHERE staff_id = $1 AND shift_date = $2 AND status != 'cancelled' ORDER BY start_time ASC`,
        [staffId, today]
      );
      if (shiftResult.rows.length === 0) {
        return res.status(400).json({ error: 'No shift scheduled for today. You can only clock in if you have a scheduled shift.' });
      }

      // Find a shift that hasn't ended yet (staff may have multiple shifts per day)
      const nowMs = now.getTime();
      let shift = null;
      let latestEndMs = 0;
      for (const s of shiftResult.rows) {
        const sd = new Date(s.shift_date);
        const [startH, startM] = (s.start_time || '00:00').toString().split(':').map(Number);
        const shiftEnd = new Date(sd);
        shiftEnd.setHours(startH || 0, startM || 0, 0, 0);
        shiftEnd.setTime(shiftEnd.getTime() + (parseFloat(s.hours) || 0) * 3600000);
        if (nowMs <= shiftEnd.getTime()) {
          shift = s;
          break;
        }
        latestEndMs = Math.max(latestEndMs, shiftEnd.getTime());
      }
      if (!shift) {
        const endStr = new Date(latestEndMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return res.status(400).json({
          error: `Your shift has already ended. The scheduled end time was ${endStr}.`
        });
      }
      const shiftId = shift.id;
      // Prevent duplicate time entries: delete any existing open entries for this staff/date/shift
      // (same logic as staff API clock-in; avoids double-counting hours when using both link + app)
      const previousEntries = await pool.query(
        `SELECT id FROM time_entries WHERE staff_id = $1 AND date = $2 AND shift_id = $3 AND clock_out_time IS NULL ORDER BY clock_in_time DESC`,
        [staffId, today, shiftId]
      );
      if (previousEntries.rows.length > 0) {
        await pool.query(`DELETE FROM time_entries WHERE id = ANY($1::bigint[])`, [previousEntries.rows.map(e => e.id)]);
      }
      await pool.query(
        `UPDATE shifts SET clocked_in_time = $1, clocked_out_time = NULL, clock_source = 'staff', status = 'in_progress' WHERE id = $2`,
        [now, shiftId]
      );
      const timeEntryResult = await pool.query(
        `INSERT INTO time_entries (user_id, staff_id, date, clock_in_time, hours_worked, overtime_hours, entry_type, shift_id)
         VALUES ((SELECT user_id FROM staff WHERE id = $1), $1, $2, $3, 0, 0, 'clock_in_out', $4) RETURNING *`,
        [staffId, today, now, shiftId]
      );
      await pool.query('UPDATE device_links SET last_used_at = NOW() WHERE id = $1', [link.id]);
      res.json({ message: 'Clocked in successfully', timeEntry: timeEntryResult.rows[0], clockInTime: now });
    } else if (action === 'clock-out') {
      const { lateReason } = req.body;
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const yesterdayStr = new Date(new Date().setDate(new Date().getDate() - 1)).toISOString().split('T')[0];
      const hasValidLocation = typeof latitude === 'number' && typeof longitude === 'number';
      if (hasValidLocation) {
        const geofenceResult = await checkGeofence(staffId, latitude, longitude);
        if (!geofenceResult.allowed) {
          return res.status(403).json({
            error: geofenceResult.error,
            requiresLocation: geofenceResult.requiresLocation || false,
            distance: geofenceResult.distance,
            radius: geofenceResult.radius
          });
        }
      }
      const shiftResult = await pool.query(
        `SELECT id, hours, status, clocked_in_time, shift_date, start_time FROM shifts
         WHERE staff_id = $1 AND (shift_date = $2 OR shift_date = $3)
         AND clocked_in_time IS NOT NULL AND clocked_out_time IS NULL`,
        [staffId, today, yesterdayStr]
      );
      // Fallback: if no shift found (deleted by manager, etc), clock out via time_entry
      if (shiftResult.rows.length === 0) {
        const entryResult = await pool.query(
          `SELECT id, clock_in_time, date FROM time_entries
           WHERE staff_id = $1 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL
           AND date >= $2::date - INTERVAL '7 days'
           ORDER BY clock_in_time DESC LIMIT 1`,
          [staffId, today]
        );
        if (entryResult.rows.length > 0) {
          const entry = entryResult.rows[0];
          const clockInTime = new Date(entry.clock_in_time);
          const totalHoursWorked = (now - clockInTime) / (1000 * 60 * 60);
          const fallbackNote = 'Shift was removed by manager; clocked out via fallback.';
          // Close only this entry (and any other open entries for this staff to prevent multiple clock-outs)
          await pool.query(
            `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2,
             notes = CASE WHEN notes IS NOT NULL AND TRIM(notes) != '' THEN notes || E'\n' || $3 ELSE $3 END WHERE id = $4`,
            [now, totalHoursWorked, fallbackNote, entry.id]
          );
          // Close any other open entries for this staff so they can't clock out again
          await pool.query(
            `UPDATE time_entries SET clock_out_time = $1, hours_worked = EXTRACT(EPOCH FROM ($1 - clock_in_time))/3600
             WHERE staff_id = $2 AND id != $3 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL
             AND date >= $4::date - INTERVAL '7 days'`,
            [now, staffId, entry.id, today]
          );
          await pool.query('UPDATE device_links SET last_used_at = NOW() WHERE id = $1', [link.id]);
          return res.json({
            message: 'Clocked out successfully. (Note: Your shift was removed, but your hours have been recorded.)',
            clockInTime,
            clockOutTime: now,
            hoursWorked: totalHoursWorked,
            shiftRemoved: true
          });
        }
        return res.status(400).json({ error: 'No active clock-in found. Please clock in first.' });
      }

      const shift = shiftResult.rows[0];
      const shiftId = shift.id;
      const clockInTime = new Date(shift.clocked_in_time);
      const clockOutTime = now;

      // Compute scheduled end: shift_date + start_time + hours
      const sd = new Date(shift.shift_date);
      const [startH, startM] = (shift.start_time || '00:00').toString().split(':').map(Number);
      const scheduledEnd = new Date(sd);
      scheduledEnd.setHours(startH || 0, startM || 0, 0, 0);
      scheduledEnd.setTime(scheduledEnd.getTime() + (parseFloat(shift.hours) || 0) * 3600000);
      const lateByMs = clockOutTime.getTime() - scheduledEnd.getTime();
      const isLateOver10Mins = lateByMs > 10 * 60 * 1000;

      if (isLateOver10Mins) {
        const reason = typeof lateReason === 'string' ? lateReason.trim() : '';
        if (!reason) {
          return res.status(400).json({
            error: 'You clocked out more than 10 minutes late. Please provide a reason.',
            requiresLateReason: true
          });
        }
        await pool.query(
          `UPDATE shifts SET clocked_out_time = $1, status = 'review_hours', approved_at = NULL, approved_by = NULL WHERE id = $2`,
          [clockOutTime, shiftId]
        );
        const totalHoursWorked = (clockOutTime - clockInTime) / (1000 * 60 * 60);
        const entryResult = await pool.query(
          `SELECT id FROM time_entries WHERE staff_id = $1 AND shift_id = $2 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL ORDER BY clock_in_time DESC LIMIT 1`,
          [staffId, shiftId]
        );
        if (entryResult.rows.length > 0) {
          await pool.query(
            `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2, notes = $3 WHERE id = $4`,
            [clockOutTime, totalHoursWorked, `Late clock-out reason: ${reason}`, entryResult.rows[0].id]
          );
        }
        // Close any other open entries for this staff
        await pool.query(
          `UPDATE time_entries SET clock_out_time = $1, hours_worked = EXTRACT(EPOCH FROM ($1::timestamptz - clock_in_time))/3600
           WHERE staff_id = $2 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL AND date >= $3::date - INTERVAL '7 days'`,
          [clockOutTime, staffId, today]
        );
        await pool.query('UPDATE device_links SET last_used_at = NOW() WHERE id = $1', [link.id]);
        return res.json({
          message: 'Clocked out successfully. Your hours have been marked for review due to late clock-out.',
          clockInTime,
          clockOutTime,
          hoursWorked: (clockOutTime - clockInTime) / (1000 * 60 * 60),
          status: 'review_hours'
        });
      }

      const totalHoursWorked = (clockOutTime - clockInTime) / (1000 * 60 * 60);
      await pool.query(
        `UPDATE shifts SET clocked_out_time = $1, status = 'approved', approved_at = NOW(), approved_by = (SELECT user_id FROM staff WHERE id = $2) WHERE id = $3`,
        [clockOutTime, staffId, shiftId]
      );
      const entryResult = await pool.query(
        `SELECT id FROM time_entries WHERE staff_id = $1 AND shift_id = $2 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL ORDER BY clock_in_time DESC LIMIT 1`,
        [staffId, shiftId]
      );
      if (entryResult.rows.length > 0) {
        await pool.query(
          `UPDATE time_entries SET clock_out_time = $1, hours_worked = $2 WHERE id = $3`,
          [clockOutTime, totalHoursWorked, entryResult.rows[0].id]
        );
      }
      // Close any other open entries for this staff so they can't clock out again
      await pool.query(
        `UPDATE time_entries SET clock_out_time = $1, hours_worked = EXTRACT(EPOCH FROM ($1::timestamptz - clock_in_time))/3600
         WHERE staff_id = $2 AND clock_in_time IS NOT NULL AND clock_out_time IS NULL
         AND date >= $3::date - INTERVAL '7 days'`,
        [clockOutTime, staffId, today]
      );
      await pool.query('UPDATE device_links SET last_used_at = NOW() WHERE id = $1', [link.id]);
      res.json({
        message: 'Clocked out successfully',
        clockInTime,
        clockOutTime,
        hoursWorked: totalHoursWorked
      });
    } else {
      return res.status(400).json({ error: 'Invalid action. Use "clock-in" or "clock-out"' });
    }
  } catch (error) {
    console.error('Clock action error:', error);
    res.status(500).json({ error: 'Failed to process clock action' });
  }
});

router.get('/status/:linkToken', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { clockinId } = req.query;
    const deviceFingerprint = req.headers['x-device-fingerprint'] || req.query.fingerprint;
    if (!clockinId) return res.json({ clockedIn: false, requiresId: true });
    const raw = String(clockinId).trim();
    const digits = raw.replace(/\D/g, '');
    const code = digits.slice(-6);
    if (code.length !== 6) return res.json({ clockedIn: false, requiresId: true });
    const linkResult = await pool.query(
      `SELECT dl.* FROM device_links dl WHERE dl.link_token = $1 AND dl.is_active = TRUE`,
      [linkToken]
    );
    if (linkResult.rows.length === 0) return res.status(404).json({ error: 'Invalid or inactive link' });
    const link = linkResult.rows[0];
    if (link.device_fingerprint && link.device_fingerprint !== deviceFingerprint) {
      return res.status(403).json({ error: 'Device fingerprint mismatch' });
    }
    // Lookup staff by last 6 digits from username (no clockin_id)
    let staffResult = raw !== code ? await pool.query(
      `SELECT s.id as staff_id FROM staff s WHERE s.username = $1 AND s.user_id = $2`,
      [raw, link.user_id]
    ) : { rows: [] };
    if (staffResult.rows.length === 0) {
      staffResult = await pool.query(
        `SELECT s.id as staff_id FROM staff s
         WHERE s.user_id = $1 AND s.username IS NOT NULL AND RIGHT(TRIM(s.username), 6) = $2`,
        [link.user_id, code]
      );
    }
    if (staffResult.rows.length === 0) {
      staffResult = await pool.query(
        `SELECT s.id as staff_id FROM staff s
         WHERE s.user_id = $1 AND s.username IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(TRIM(s.username), '[^0-9]', '', 'g'), 6) = $2`,
        [link.user_id, code]
      );
    }
    if (staffResult.rows.length === 0) return res.status(403).json({ error: 'Invalid clock-in code' });
    const staffId = staffResult.rows[0].staff_id;
    const today = new Date().toISOString().split('T')[0];
    const statusResult = await pool.query(
      `SELECT te.* FROM time_entries te LEFT JOIN shifts s ON te.shift_id = s.id
       WHERE te.staff_id = $1 AND te.date = $2 AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NULL
       AND (s.id IS NULL OR s.clocked_out_time IS NULL) ORDER BY te.clock_in_time DESC LIMIT 1`,
      [staffId, today]
    );
    if (statusResult.rows.length === 0) return res.json({ clockedIn: false });
    res.json({
      clockedIn: true,
      timeEntry: statusResult.rows[0],
      clockInTime: statusResult.rows[0].clock_in_time
    });
  } catch (error) {
    console.error('Get clock status error:', error);
    res.status(500).json({ error: 'Failed to get clock status' });
  }
});

export default router;
