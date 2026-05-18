import express from 'express';
import { pool } from '../lib/db.js';
import { sanitizeString } from '../lib/sanitize.js';
import {
  getShifts,
  getShiftById,
  createShift,
  updateShift,
  deleteShift,
  createBulkShifts,
  getShiftStats,
  checkShiftConflict,
  calculateEndTime,
  INVALID_STAFF_ID,
  approveShift,
  approveShifts,
  unapproveShift,
} from '../services/shifts.js';
import {
  createSwapRequest,
  getSwapRequestsForStaff,
  getSwapRequestsForCompany,
  acceptSwapRequest,
  rejectSwapRequest,
  cancelSwapRequest,
  getSwapRequestById,
} from '../services/shift-swaps.js';
import {
  requireAuth,
  requireStaffAuth,
  authenticateStaffOrUser,
  authenticateStaffOrUserPreferEmployer,
} from '../middleware/auth.js';
import { requireSubscription } from '../middleware/obfuscation.js';
import { logShiftActivity } from '../lib/activity.js';
import { mergePermissions } from '../lib/managerPermissions.js';

const router = express.Router();

router.get('/shifts', async (req, res) => {
  try {
    const apiKey =
      req.headers['x-api-key'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer wak_')
        ? req.headers.authorization.replace('Bearer ', '')
        : null);

    if (apiKey && apiKey.startsWith('wak_')) {
      const { verifyApiKey } = await import('../lib/api-security.js');
      const keyData = await verifyApiKey(apiKey);
      if (keyData) {
        req.userId = keyData.user_id;
        req.apiKey = keyData;
      } else {
        return res.status(401).json({ error: 'Invalid or expired API key' });
      }
    } else {
      const authResult = await authenticateStaffOrUserPreferEmployer(req, res);
      if (!authResult && !req.userId) {
        if (!res.headersSent) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        return;
      }
    }

    const {
      startDate,
      endDate,
      status,
      staffId: filterStaffId,
      timezoneOffset,
      clientNow,
    } = req.query;

    const filters = { startDate, endDate, staffId: filterStaffId, status };
    if (timezoneOffset !== undefined && timezoneOffset !== '') {
      const offset = parseInt(timezoneOffset, 10);
      if (!isNaN(offset)) filters.timezoneOffset = offset;
    }
    if (clientNow !== undefined && clientNow !== '') {
      const ts = parseInt(clientNow, 10);
      if (!isNaN(ts)) filters.clientNow = ts;
    }

    if (req.staff && !req.apiKey) {
      const role = req.staff.accessRole || 'employee';
      if (role === 'employee') {
        filters.staffId = req.staffId;
        delete filters.managerStaffId;
      } else if (role === 'manager' || role === 'payroll_admin') {
        const permResult = await pool.query('SELECT manager_permissions FROM users WHERE id = $1', [
          req.staff.companyUserId,
        ]);
        const perms = mergePermissions(permResult.rows[0]?.manager_permissions);
        if (!perms.schedule?.read) {
          return res.status(403).json({ error: 'Schedule access not permitted' });
        }
        filters.managerStaffId = req.staffId;
        if (filterStaffId !== undefined && filterStaffId !== '') {
          const wantSid = parseInt(String(filterStaffId), 10);
          if (!Number.isNaN(wantSid)) {
            const teamCheck = await pool.query(
              `SELECT id FROM staff
               WHERE id = $1 AND manager_id = $2 AND user_id = $3`,
              [wantSid, req.staffId, req.staff.companyUserId]
            );
            if (teamCheck.rows.length === 0) {
              return res
                .status(403)
                .json({ error: 'You can only view shifts for your direct reports' });
            }
            filters.staffId = wantSid;
          }
        }
      }
    }

    const shifts = await getShifts(req.userId, filters);
    if (res.headersSent) return;

    const payload = { shifts };
    res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('X-Shifts-ClientNow', filters.clientNow ? 'yes' : 'no');
    res.set(
      'X-Shifts-TimezoneOffset',
      filters.timezoneOffset !== undefined ? String(filters.timezoneOffset) : 'none'
    );

    res.json(payload);
  } catch (error) {
    console.error('Get shifts error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get shifts' });
    }
  }
});

router.get('/shifts/stats', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await getShiftStats(req.userId, { startDate, endDate });
    res.json(stats);
  } catch (error) {
    console.error('Get shift stats error:', error);
    res.status(500).json({ error: 'Failed to get shift statistics' });
  }
});

router.get('/shifts/:id', requireAuth, async (req, res) => {
  try {
    const shift = await getShiftById(req.params.id, req.userId);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json({ shift });
  } catch (error) {
    console.error('Get shift error:', error);
    res.status(500).json({ error: 'Failed to get shift' });
  }
});

router.post('/shifts', requireAuth, async (req, res) => {
  try {
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
    } = req.body;
    if (!staffId || !shiftDate || !startTime || !hours) {
      return res.status(400).json({ error: 'Staff ID, date, start time, and hours are required' });
    }
    const normalizedDate = shiftDate.split('T')[0];
    const calculatedEndTime = calculateEndTime(startTime, parseFloat(hours));
    const conflictResult = await checkShiftConflict(
      req.userId,
      staffId,
      normalizedDate,
      startTime,
      calculatedEndTime
    );
    if (conflictResult.hasConflict) {
      const conflicts = conflictResult.conflictingShifts;
      const conflictTimes = conflicts.map((c) => `${c.start}-${c.end}`).join(', ');
      return res.status(409).json({
        error: `This shift conflicts with an existing shift for this staff member. Conflicting shift time(s): ${conflictTimes}`,
        conflictingShifts: conflicts,
      });
    }
    const shift = await createShift(
      req.userId,
      {
        staffId,
        shiftDate: normalizedDate,
        startTime,
        hours: parseFloat(hours),
        breakMinutes,
        shiftType,
        payType,
        location: location ? sanitizeString(location) : location,
        notes: notes ? sanitizeString(notes) : notes,
      },
      { createdByUserId: req.userId }
    );
    res.status(201).json({ message: 'Shift created successfully', shift });
  } catch (error) {
    console.error('Create shift error:', error);
    if (error.message === INVALID_STAFF_ID) {
      return res.status(400).json({ error: 'Staff ID must be a positive integer' });
    }
    if (error.message && error.message.includes('does not belong to this user')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to create shifts for this staff member' });
    }
    res.status(500).json({ error: 'Failed to create shift', details: error.message });
  }
});

router.post('/shifts/bulk', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { shifts } = req.body;
    if (!shifts || !Array.isArray(shifts) || shifts.length === 0) {
      return res.status(400).json({ error: 'Shifts array is required' });
    }
    const validatedShifts = shifts.map((shift) => {
      if (!shift.staffId || !shift.shiftDate || !shift.startTime || !shift.hours) {
        throw new Error('Each shift must have staffId, shiftDate, startTime, and hours');
      }
      return { ...shift, hours: parseFloat(shift.hours) };
    });
    const createdShifts = await createBulkShifts(req.userId, validatedShifts, {
      createdByUserId: req.userId,
    });
    res.status(201).json({
      message: `${createdShifts.length} shifts created successfully`,
      shifts: createdShifts,
    });
  } catch (error) {
    console.error('Create bulk shifts error:', error);
    if (error.message === INVALID_STAFF_ID) {
      return res.status(400).json({ error: 'Staff ID must be a positive integer' });
    }
    if (error.message && error.message.includes('does not belong to this user')) {
      return res.status(403).json({
        error: 'You do not have permission to create shifts for one or more staff members',
      });
    }
    res.status(500).json({ error: 'Failed to create shifts' });
  }
});

router.put('/shifts/:id', requireAuth, async (req, res) => {
  try {
    const {
      staffId,
      shiftDate,
      startTime,
      hours,
      breakMinutes,
      shiftType,
      payType,
      status,
      location,
      notes,
      clockedInTime,
      clockedOutTime,
    } = req.body;
    let calculatedEndTime = null;
    if (startTime && hours) {
      calculatedEndTime = calculateEndTime(startTime, parseFloat(hours));
    }
    if (staffId && shiftDate && startTime && calculatedEndTime) {
      const conflictResult = await checkShiftConflict(
        req.userId,
        staffId,
        shiftDate,
        startTime,
        calculatedEndTime,
        req.params.id
      );
      if (conflictResult.hasConflict) {
        const conflicts = conflictResult.conflictingShifts;
        const conflictTimes = conflicts.map((c) => `${c.start}-${c.end}`).join(', ');
        return res.status(409).json({
          error: `This shift conflicts with an existing shift for this staff member. Conflicting shift time(s): ${conflictTimes}`,
          conflictingShifts: conflicts,
        });
      }
    }
    const shift = await updateShift(req.params.id, req.userId, {
      staffId,
      shiftDate,
      startTime,
      hours: hours ? parseFloat(hours) : undefined,
      breakMinutes,
      shiftType,
      payType,
      status,
      location,
      notes,
      clockedInTime,
      clockedOutTime,
    });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json({ message: 'Shift updated successfully', shift });
  } catch (error) {
    console.error('Update shift error:', error);
    if (error.message === INVALID_STAFF_ID) {
      return res.status(400).json({ error: 'Staff ID must be a positive integer' });
    }
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

router.delete('/shifts/:id', requireAuth, async (req, res) => {
  try {
    await deleteShift(req.params.id, req.userId);
    res.json({ message: 'Shift deleted successfully' });
  } catch (error) {
    console.error('Delete shift error:', error);
    if (error.message === 'Shift not found or you do not have permission to delete it') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

router.post('/shifts/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await approveShift(req.params.id, req.userId, req.userId);
    await logShiftActivity(
      req.userId,
      result.shift.staff_id,
      result.shift.id,
      'approved',
      `Approved shift for ${result.shift.staff_name} on ${new Date(result.shift.shift_date).toLocaleDateString()}`
    );
    res.json({
      message: 'Shift approved and hours logged successfully',
      timeEntryId: result.timeEntryId,
      regularHours: result.regularHours,
      overtimeHours: result.overtimeHours,
      scheduledHours: result.scheduledHours,
      actualHoursWorked: result.actualHoursWorked,
    });
  } catch (error) {
    console.error('Approve shift error:', error);
    res.status(400).json({ error: error.message || 'Failed to approve shift' });
  }
});

router.post('/shifts/approve-bulk', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { shiftIds } = req.body;
    if (!shiftIds || !Array.isArray(shiftIds) || shiftIds.length === 0) {
      return res.status(400).json({ error: 'Shift IDs array is required' });
    }
    const { results, errors } = await approveShifts(shiftIds, req.userId, req.userId);
    for (const result of results) {
      await logShiftActivity(
        req.userId,
        result.shift.staff_id,
        result.shift.id,
        'approved',
        `Approved shift for ${result.shift.staff_name}`
      );
    }
    res.json({
      message: `${results.length} shifts approved successfully`,
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Bulk approve shifts error:', error);
    res.status(500).json({ error: 'Failed to approve shifts' });
  }
});

router.post('/shifts/:id/unapprove', requireAuth, async (req, res) => {
  try {
    await unapproveShift(req.params.id, req.userId);
    res.json({ message: 'Shift approval reversed successfully' });
  } catch (error) {
    console.error('Unapprove shift error:', error);
    res.status(500).json({ error: error.message || 'Failed to reverse shift approval' });
  }
});

router.post('/shifts/:id/swap-request', requireStaffAuth, async (req, res) => {
  try {
    const { requestedShiftId, message } = req.body;
    if (!requestedShiftId) return res.status(400).json({ error: 'requestedShiftId is required' });
    const swapRequest = await createSwapRequest(
      req.staffId,
      req.params.id,
      requestedShiftId,
      message
    );
    res.status(201).json({ message: 'Swap request created successfully', swapRequest });
  } catch (error) {
    console.error('Create swap request error:', error);
    res.status(400).json({ error: error.message || 'Failed to create swap request' });
  }
});

router.get('/shift-swaps', async (req, res) => {
  try {
    const authResult = await authenticateStaffOrUser(req, res);
    if (!authResult) {
      if (!res.headersSent) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      return;
    }
    const { status } = req.query;
    const filters = status ? { status } : {};
    if (authResult.isStaff) {
      const swapRequests = await getSwapRequestsForStaff(authResult.staffId, filters);
      return res.json({ swapRequests });
    }
    if (!req.userId) {
      if (!res.headersSent) {
        return res.status(401).json({ error: 'User ID not found' });
      }
      return;
    }
    const swapRequests = await getSwapRequestsForCompany(req.userId, filters);
    return res.json({ swapRequests });
  } catch (error) {
    console.error('Get swap requests error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get swap requests' });
    }
  }
});

router.get('/shift-swaps/:id', async (req, res) => {
  try {
    const authResult = await authenticateStaffOrUser(req, res);
    if (!authResult) {
      if (!res.headersSent) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      return;
    }
    const swapRequest = authResult.isStaff
      ? await getSwapRequestById(req.params.id, authResult.staffId)
      : await getSwapRequestById(req.params.id, null, req.userId);
    if (!swapRequest) {
      if (!res.headersSent) {
        return res.status(404).json({ error: 'Swap request not found' });
      }
      return;
    }
    return res.json({ swapRequest });
  } catch (error) {
    console.error('Get swap request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get swap request' });
    }
  }
});

router.post('/shift-swaps/:id/accept', requireStaffAuth, async (req, res) => {
  try {
    const swapRequest = await acceptSwapRequest(req.params.id, req.staffId);
    res.json({
      message: 'Swap request accepted successfully. Shifts have been swapped.',
      swapRequest,
    });
  } catch (error) {
    console.error('Accept swap request error:', error);
    res.status(400).json({ error: error.message || 'Failed to accept swap request' });
  }
});

router.post('/shift-swaps/:id/reject', requireStaffAuth, async (req, res) => {
  try {
    const swapRequest = await rejectSwapRequest(req.params.id, req.staffId);
    res.json({ message: 'Swap request rejected successfully', swapRequest });
  } catch (error) {
    console.error('Reject swap request error:', error);
    res.status(400).json({ error: error.message || 'Failed to reject swap request' });
  }
});

router.delete('/shift-swaps/:id', requireStaffAuth, async (req, res) => {
  try {
    const swapRequest = await cancelSwapRequest(req.params.id, req.staffId);
    res.json({ message: 'Swap request cancelled successfully', swapRequest });
  } catch (error) {
    console.error('Cancel swap request error:', error);
    res.status(400).json({ error: error.message || 'Failed to cancel swap request' });
  }
});

export default router;
