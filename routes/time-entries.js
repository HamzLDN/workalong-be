import express from 'express';
import {
  getTimeEntries,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  getPendingTimeEntries,
  approveTimeEntry,
  unapproveTimeEntry,
  getMonthlyEarningsChart,
  getPayrollForPeriod,
} from '../services/staff.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/time-entries', requireAuth, async (req, res) => {
  try {
    const { staffId, startDate, endDate } = req.query;
    const entries = await getTimeEntries(req.userId, { staffId, startDate, endDate });
    res.json({ entries });
  } catch (error) {
    console.error('Get time entries error:', error);
    res.status(500).json({ error: 'Failed to get time entries' });
  }
});

/** Get clock_in_out time entries pending approval (for review table with per-entry approve). */
router.get('/time-entries/pending', requireAuth, async (req, res) => {
  try {
    const { staffId, startDate, endDate } = req.query;
    const entries = await getPendingTimeEntries(req.userId, { staffId, startDate, endDate });
    res.json({ entries });
  } catch (error) {
    console.error('Get pending time entries error:', error);
    res.status(500).json({ error: 'Failed to get pending time entries' });
  }
});

router.post('/time-entries/:id/approve', requireAuth, async (req, res) => {
  try {
    const entry = await approveTimeEntry(req.params.id, req.userId);
    res.json({ message: 'Time entry approved', entry });
  } catch (error) {
    console.error('Approve time entry error:', error);
    res.status(400).json({ error: error.message || 'Failed to approve time entry' });
  }
});

router.post('/time-entries/:id/unapprove', requireAuth, async (req, res) => {
  try {
    await unapproveTimeEntry(req.params.id, req.userId);
    res.json({ message: 'Time entry unapproved' });
  } catch (error) {
    console.error('Unapprove time entry error:', error);
    res.status(400).json({ error: error.message || 'Failed to unapprove time entry' });
  }
});

/** Payroll for period: only actual clocked hours (clock_in + clock_out) per staff. */
router.get('/payroll-preview', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    const data = await getPayrollForPeriod(req.userId, startDate, endDate);
    res.json(data);
  } catch (error) {
    console.error('Payroll preview error:', error);
    res.status(500).json({ error: 'Failed to load payroll preview' });
  }
});

router.get('/earnings/monthly', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.query;
    const yearNum = year ? parseInt(year) : undefined;
    const monthNum = month ? parseInt(month) - 1 : undefined;
    const chartData = await getMonthlyEarningsChart(req.userId, yearNum, monthNum);
    res.json(chartData);
  } catch (error) {
    console.error('Get monthly earnings chart error:', error);
    res.status(500).json({ error: 'Failed to get monthly earnings chart data' });
  }
});

router.post('/time-entries', requireAuth, async (req, res) => {
  try {
    const { staffId, date, hoursWorked, overtimeHours, notes, leaveCategory } = req.body;
    if (!staffId || !date || hoursWorked === undefined) {
      return res.status(400).json({ error: 'Staff ID, date, and hours worked are required' });
    }
    if (hoursWorked < 0) {
      return res.status(400).json({ error: 'Hours worked must be positive' });
    }
    const entry = await createTimeEntry(req.userId, {
      staffId,
      date,
      hoursWorked,
      overtimeHours,
      notes,
      leaveCategory,
    });
    res.status(201).json({ message: 'Time entry created successfully', entry });
  } catch (error) {
    console.error('Create time entry error:', error);
    res.status(500).json({ error: 'Failed to create time entry' });
  }
});

router.put('/time-entries/:id', requireAuth, async (req, res) => {
  try {
    const { staffId, date, hoursWorked, overtimeHours, notes, leaveCategory } = req.body;
    if (!staffId || !date || hoursWorked === undefined) {
      return res.status(400).json({ error: 'Staff ID, date, and hours worked are required' });
    }
    if (hoursWorked < 0) {
      return res.status(400).json({ error: 'Hours worked must be positive' });
    }
    const entry = await updateTimeEntry(req.userId, req.params.id, {
      staffId,
      date,
      hoursWorked,
      overtimeHours,
      notes,
      leaveCategory,
    });
    res.json({ message: 'Time entry updated', entry });
  } catch (error) {
    console.error('Update time entry error:', error);
    const msg = error.message || 'Failed to update time entry';
    const code = msg.includes('not found') || msg.includes('cannot be edited') ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

router.delete('/time-entries/:id', requireAuth, async (req, res) => {
  try {
    await deleteTimeEntry(req.params.id, req.userId);
    res.json({ message: 'Time entry deleted successfully' });
  } catch (error) {
    console.error('Delete time entry error:', error);
    const msg = error.message || 'Failed to delete time entry';
    const code = msg.includes('not found') || msg.includes('cannot be deleted') ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

export default router;
