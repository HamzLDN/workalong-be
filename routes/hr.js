import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../lib/db.js';
import {
  listAvailability,
  upsertAvailability,
  deleteAvailability,
  listLeaveRequests,
  createLeaveRequest,
  reviewLeaveRequest,
  listDocuments,
  createDocument,
  listExpiringDocuments,
  listExpenses,
  createExpense,
  reviewExpense,
  listNotifications,
  markNotificationRead,
  createPayrollRun,
  listPayrollRuns,
  getPayslipsForRun,
  publishRotaWeek,
  getSchedulingInsights,
} from '../services/hr.js';
import { payslipSummaryText } from '../lib/payrollRuns.js';
import {
  listEscalationReports,
  getEscalationReport,
  createEscalationReport,
  updateEscalationReport,
} from '../services/escalationReports.js';

const router = express.Router();

function parseStaffId(req) {
  const id = parseInt(req.params.staffId || req.body.staffId, 10);
  return Number.isNaN(id) ? null : id;
}

router.get('/availability', requireAuth, async (req, res) => {
  try {
    const staffId = req.query.staffId ? parseInt(req.query.staffId, 10) : undefined;
    const rows = await listAvailability(req.userId, {
      staffId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json({ availability: rows });
  } catch (e) {
    console.error('List availability error:', e);
    res.status(500).json({ error: 'Failed to list availability' });
  }
});

router.post('/availability', requireAuth, async (req, res) => {
  try {
    const staffId = parseStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    const row = await upsertAvailability(req.userId, staffId, {
      weekday: req.body.weekday,
      specificDate: req.body.specificDate,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      status: req.body.status || 'available',
      isRecurring: req.body.isRecurring,
      notes: req.body.notes,
    });
    res.status(201).json({ availability: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to save availability' });
  }
});

router.delete('/availability/:id', requireAuth, async (req, res) => {
  try {
    const ok = await deleteAvailability(req.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Availability slot not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete availability' });
  }
});

router.get('/leave-requests', requireAuth, async (req, res) => {
  try {
    const rows = await listLeaveRequests(req.userId, {
      staffId: req.query.staffId ? parseInt(req.query.staffId, 10) : undefined,
      status: req.query.status,
    });
    res.json({ leaveRequests: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list leave requests' });
  }
});

router.post('/leave-requests', requireAuth, async (req, res) => {
  try {
    const staffId = parseStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    const row = await createLeaveRequest(req.userId, staffId, req.body);
    res.status(201).json({ leaveRequest: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to create leave request' });
  }
});

router.post('/leave-requests/:id/review', requireAuth, async (req, res) => {
  try {
    const { status, reviewNotes, reviewerStaffId } = req.body;
    const row = await reviewLeaveRequest(req.userId, req.params.id, {
      status,
      reviewNotes,
      reviewerStaffId,
    });
    res.json({ leaveRequest: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to review leave request' });
  }
});

router.get('/documents', requireAuth, async (req, res) => {
  try {
    const rows = await listDocuments(req.userId, {
      staffId: req.query.staffId ? parseInt(req.query.staffId, 10) : undefined,
    });
    res.json({ documents: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

router.get('/documents/expiring', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.withinDays || '30', 10);
    const rows = await listExpiringDocuments(req.userId, days);
    res.json({ documents: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list expiring documents' });
  }
});

router.post('/documents', requireAuth, async (req, res) => {
  try {
    const staffId = parseStaffId(req);
    if (!staffId || !req.body.docType || !req.body.fileName) {
      return res.status(400).json({ error: 'staffId, docType and fileName are required' });
    }
    const row = await createDocument(req.userId, staffId, req.body);
    res.status(201).json({ document: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to upload document' });
  }
});

router.get('/expenses', requireAuth, async (req, res) => {
  try {
    const rows = await listExpenses(req.userId, {
      staffId: req.query.staffId ? parseInt(req.query.staffId, 10) : undefined,
      status: req.query.status,
    });
    res.json({ expenses: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list expenses' });
  }
});

router.post('/expenses', requireAuth, async (req, res) => {
  try {
    const staffId = parseStaffId(req);
    if (!staffId || !req.body.category) {
      return res.status(400).json({ error: 'staffId and category are required' });
    }
    const row = await createExpense(req.userId, staffId, req.body);
    res.status(201).json({ expense: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to create expense' });
  }
});

router.post('/expenses/:id/review', requireAuth, async (req, res) => {
  try {
    const row = await reviewExpense(req.userId, req.params.id, req.body);
    res.json({ expense: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to review expense' });
  }
});

router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const rows = await listNotifications(req.userId, {
      unreadOnly: req.query.unreadOnly === 'true',
      limit: parseInt(req.query.limit || '50', 10),
    });
    res.json({ notifications: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const row = await markNotificationRead(req.userId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: row });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.get('/payroll-runs', requireAuth, async (req, res) => {
  try {
    const rows = await listPayrollRuns(req.userId);
    res.json({ payrollRuns: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list payroll runs' });
  }
});

router.post('/payroll-runs', requireAuth, async (req, res) => {
  try {
    const { periodStart, periodEnd, scheduleType } = req.body;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'periodStart and periodEnd are required' });
    }
    const result = await createPayrollRun(req.userId, { periodStart, periodEnd, scheduleType });
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to create payroll run' });
  }
});

router.get('/payroll-runs/:id/payslips', requireAuth, async (req, res) => {
  try {
    const payslips = await getPayslipsForRun(req.userId, req.params.id);
    res.json({ payslips });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get payslips' });
  }
});

router.get('/payroll-runs/:runId/payslips/:payslipId/download', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, s.name AS staff_name FROM payslips p
       JOIN staff s ON s.id = p.staff_id
       WHERE p.id = $1 AND p.payroll_run_id = $2 AND p.user_id = $3`,
      [req.params.payslipId, req.params.runId, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Payslip not found' });
    const p = r.rows[0];
    const text = payslipSummaryText(
      { grossPay: p.gross_pay, netPay: p.net_pay, hoursWorked: p.hours_worked },
      p.staff_name
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.id}.txt"`);
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: 'Failed to download payslip' });
  }
});

router.post('/rota/publish', requireAuth, async (req, res) => {
  try {
    const { weekStart } = req.body;
    if (!weekStart) return res.status(400).json({ error: 'weekStart is required' });
    const row = await publishRotaWeek(req.userId, weekStart, req.userId);
    res.json({ published: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to publish rota' });
  }
});

router.get('/scheduling-insights', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    const insights = await getSchedulingInsights(req.userId, { startDate, endDate });
    res.json(insights);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get scheduling insights' });
  }
});

router.put('/staff/:staffId/profile', requireAuth, async (req, res) => {
  try {
    const staffId = req.params.staffId;
    const data = {
      ...req.body,
      phone: req.body.phone,
      address: req.body.address,
      emergencyContact: req.body.emergencyContact,
      dateOfBirth: req.body.dateOfBirth,
      nationalInsurance: req.body.nationalInsurance,
      nationality: req.body.nationality,
      gender: req.body.gender,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      salary: req.body.salary,
      taxCode: req.body.taxCode,
      niCategory: req.body.niCategory,
      bankSortCode: req.body.bankSortCode,
      bankAccountLast4: req.body.bankAccountLast4,
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM staff WHERE id = $1 AND user_id = $2', [
        staffId,
        req.userId,
      ]);
      if (!exists.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Staff member not found' });
      }
      const fields = [
        ['phone', data.phone],
        ['address', data.address],
        ['emergency_contact', data.emergencyContact],
        ['date_of_birth', data.dateOfBirth],
        ['national_insurance', data.nationalInsurance],
        ['nationality', data.nationality],
        ['gender', data.gender],
        ['start_date', data.startDate],
        ['end_date', data.endDate],
        ['salary', data.salary],
        ['tax_code', data.taxCode],
        ['ni_category', data.niCategory],
        ['bank_sort_code', data.bankSortCode],
        ['bank_account_last4', data.bankAccountLast4],
      ];
      const updates = [];
      const values = [];
      let p = 1;
      for (const [col, val] of fields) {
        if (val !== undefined) {
          updates.push(`${col} = $${p++}`);
          values.push(val === '' ? null : val);
        }
      }
      if (!updates.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No profile fields to update' });
      }
      updates.push(`updated_at = NOW()`);
      values.push(staffId, req.userId);
      const result = await client.query(
        `UPDATE staff SET ${updates.join(', ')} WHERE id = $${p++} AND user_id = $${p} RETURNING *`,
        values
      );
      await client.query('COMMIT');
      res.json({ staff: result.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update profile' });
  }
});

router.get('/escalation-reports', requireAuth, async (req, res) => {
  try {
    const rows = await listEscalationReports(req.userId, {
      status: req.query.status,
      staffId: req.query.staffId ? parseInt(req.query.staffId, 10) : undefined,
    });
    res.json({ reports: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list escalation reports' });
  }
});

router.get('/escalation-reports/:id', requireAuth, async (req, res) => {
  try {
    const row = await getEscalationReport(req.userId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: row });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get report' });
  }
});

router.post('/escalation-reports', requireAuth, async (req, res) => {
  try {
    const staffId = parseStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    const row = await createEscalationReport(req.userId, staffId, req.body);
    res.status(201).json({ report: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to create report' });
  }
});

router.patch('/escalation-reports/:id', requireAuth, async (req, res) => {
  try {
    const row = await updateEscalationReport(req.userId, req.params.id, req.body);
    res.json({ report: row });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to update report' });
  }
});

export default router;
