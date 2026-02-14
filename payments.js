import express from 'express';
import Stripe from 'stripe';
import { config } from './config.js';
import { pool } from './db.js';

const router = express.Router();
const stripe = new Stripe(config.stripe.secretKey);

// Middleware to check authentication
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// ============================================
// PAYMENT SCHEDULE ENDPOINTS
// ============================================

// GET payment schedule for user
router.get('/schedule', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payment_schedules WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ schedule: null });
    }

    res.json({ schedule: result.rows[0] });
  } catch (error) {
    console.error('Error fetching payment schedule:', error);
    res.status(500).json({ error: 'Failed to fetch payment schedule' });
  }
});

// POST create or update payment schedule
router.post('/schedule', requireAuth, async (req, res) => {
  try {
    const { scheduleType, paymentDay, customSchedule } = req.body;

    if (!scheduleType || !['weekly', 'bi-weekly', 'monthly', 'custom'].includes(scheduleType)) {
      return res.status(400).json({ error: 'Valid schedule type required' });
    }

    // Calculate next payment date
    const nextPaymentDate = calculateNextPaymentDate(scheduleType, paymentDay);

    // Check if schedule already exists
    const existingSchedule = await pool.query(
      'SELECT id FROM payment_schedules WHERE user_id = $1',
      [req.session.userId]
    );

    let result;
    if (existingSchedule.rows.length > 0) {
      // Update existing schedule
      result = await pool.query(
        `UPDATE payment_schedules 
         SET schedule_type = $1, payment_day = $2, custom_schedule = $3, 
             next_payment_date = $4, is_active = true, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5
         RETURNING *`,
        [scheduleType, paymentDay, customSchedule, nextPaymentDate, req.session.userId]
      );
    } else {
      // Create new schedule
      result = await pool.query(
        `INSERT INTO payment_schedules (user_id, schedule_type, payment_day, custom_schedule, next_payment_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.session.userId, scheduleType, paymentDay, customSchedule, nextPaymentDate]
      );
    }

    res.json({ 
      message: 'Payment schedule saved successfully',
      schedule: result.rows[0]
    });
  } catch (error) {
    console.error('Error saving payment schedule:', error);
    res.status(500).json({ error: 'Failed to save payment schedule' });
  }
});

// DELETE deactivate payment schedule
router.delete('/schedule', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE payment_schedules SET is_active = false WHERE user_id = $1',
      [req.session.userId]
    );

    res.json({ message: 'Payment schedule deactivated' });
  } catch (error) {
    console.error('Error deactivating schedule:', error);
    res.status(500).json({ error: 'Failed to deactivate schedule' });
  }
});

// ============================================
// STAFF PAYMENT DETAILS ENDPOINTS
// ============================================

// GET payment details for a staff member
router.get('/staff/:staffId/details', requireAuth, async (req, res) => {
  try {
    const { staffId } = req.params;

    const result = await pool.query(
      `SELECT spd.*, s.name as staff_name 
       FROM staff_payment_details spd
       JOIN staff s ON s.id = spd.staff_id
       WHERE spd.staff_id = $1 AND spd.user_id = $2`,
      [staffId, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ paymentDetails: null });
    }

    // Don't send sensitive info to frontend
    const details = result.rows[0];
    delete details.account_number;
    delete details.iban;
    delete details.swift_bic;

    res.json({ paymentDetails: details });
  } catch (error) {
    console.error('Error fetching payment details:', error);
    res.status(500).json({ error: 'Failed to fetch payment details' });
  }
});

// POST add or update staff payment details
router.post('/staff/:staffId/details', requireAuth, async (req, res) => {
  try {
    const { staffId } = req.params;
    const {
      paymentMethod,
      accountHolderName,
      bankName,
      accountNumber,
      sortCode,
      iban,
      swiftBic
    } = req.body;

    // Verify staff belongs to user
    const staffCheck = await pool.query(
      'SELECT id FROM staff WHERE id = $1 AND user_id = $2',
      [staffId, req.session.userId]
    );

    if (staffCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Check if payment details exist
    const existing = await pool.query(
      'SELECT id FROM staff_payment_details WHERE staff_id = $1 AND user_id = $2',
      [staffId, req.session.userId]
    );

    let result;
    if (existing.rows.length > 0) {
      // Update existing
      result = await pool.query(
        `UPDATE staff_payment_details 
         SET payment_method = $1, account_holder_name = $2, bank_name = $3,
             account_number = $4, sort_code = $5, iban = $6, swift_bic = $7,
             is_verified = false, updated_at = CURRENT_TIMESTAMP
         WHERE staff_id = $8 AND user_id = $9
         RETURNING id, staff_id, payment_method, account_holder_name, bank_name, is_verified`,
        [paymentMethod, accountHolderName, bankName, accountNumber, sortCode, 
         iban, swiftBic, staffId, req.session.userId]
      );
    } else {
      // Create new
      result = await pool.query(
        `INSERT INTO staff_payment_details 
         (staff_id, user_id, payment_method, account_holder_name, bank_name,
          account_number, sort_code, iban, swift_bic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, staff_id, payment_method, account_holder_name, bank_name, is_verified`,
        [staffId, req.session.userId, paymentMethod, accountHolderName, bankName,
         accountNumber, sortCode, iban, swiftBic]
      );
    }

    res.json({
      message: 'Payment details saved successfully',
      paymentDetails: result.rows[0]
    });
  } catch (error) {
    console.error('Error saving payment details:', error);
    res.status(500).json({ error: 'Failed to save payment details' });
  }
});

// ============================================
// PAYMENT PROCESSING ENDPOINTS
// ============================================

// POST process manual payment for a staff member
router.post('/process/:staffId', requireAuth, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { periodStart, periodEnd, amount: bodyAmount, notes } = req.body;

    // Get staff details
    const staffResult = await pool.query(
      `SELECT s.*, spd.payment_method, spd.stripe_account_id, spd.is_verified
       FROM staff s
       LEFT JOIN staff_payment_details spd ON s.id = spd.staff_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [staffId, req.session.userId]
    );

    if (staffResult.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staff = staffResult.rows[0];

    if (!staff.payment_method) {
      return res.status(400).json({ error: 'Payment details not set up for this staff member' });
    }

    // Payroll = only actual clocked time for this staff in the period (deduped by shift to avoid double-counting)
    let amount = bodyAmount;
    if (periodStart && periodEnd) {
      const payrollResult = await pool.query(
        `WITH deduped AS (
           SELECT DISTINCT ON (te.staff_id, te.date, COALESCE(te.shift_id::text, 'f' || te.id::text))
             te.staff_id, te.clock_in_time, te.clock_out_time
           FROM time_entries te
           LEFT JOIN shifts s ON s.id = te.shift_id
           WHERE te.staff_id = $1 AND te.user_id = $2 AND te.date BETWEEN $3 AND $4
             AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
             AND te.entry_type = 'clock_in_out'
             AND (te.shift_id IS NULL OR s.clock_source = 'staff')
           ORDER BY te.staff_id, te.date, COALESCE(te.shift_id::text, 'f' || te.id::text), te.id DESC
         )
         SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (d.clock_out_time - d.clock_in_time)) / 3600.0), 0)::numeric(10,2) as hours_worked,
                COALESCE(SUM((EXTRACT(EPOCH FROM (d.clock_out_time - d.clock_in_time)) / 3600.0) * s.hourly_rate), 0)::numeric(12,2) as total_cost
         FROM deduped d
         JOIN staff s ON s.id = d.staff_id
         WHERE d.staff_id = $1 AND s.user_id = $2`,
        [staffId, req.session.userId, periodStart, periodEnd]
      );
      const row = payrollResult.rows[0];
      amount = parseFloat(row?.total_cost ?? 0);
    }

    if (amount == null || amount < 0) {
      return res.status(400).json({ error: 'Valid amount or period (periodStart, periodEnd) required' });
    }
    if (amount === 0) {
      return res.status(400).json({ error: 'No clocked hours in this period for this staff' });
    }

    // Create payment history record
    const paymentResult = await pool.query(
      `INSERT INTO payment_history 
       (user_id, staff_id, amount, payment_period_start, payment_period_end,
        payment_method, payment_status, scheduled_date, is_automatic, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_DATE, false, $7)
       RETURNING *`,
      [req.session.userId, staffId, amount, periodStart, periodEnd, 
       staff.payment_method, notes]
    );

    const payment = paymentResult.rows[0];

    // For demo purposes, we'll mark as processing
    // In production, you would integrate with actual payment providers
    await pool.query(
      `UPDATE payment_history 
       SET payment_status = 'processing', processed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [payment.id]
    );

    // Simulate successful payment (in production, handle webhooks/callbacks)
    setTimeout(async () => {
      try {
        await pool.query(
          `UPDATE payment_history 
           SET payment_status = 'completed', completed_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [payment.id]
        );
      } catch (err) {
        console.error('Error updating payment status:', err);
      }
    }, 2000);

    res.json({
      message: 'Payment initiated successfully',
      payment: {
        ...payment,
        payment_status: 'processing'
      }
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// POST process automatic payments for all staff
router.post('/process-all', requireAuth, async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.body;

    // Only pay for actual clocked time: entries with both clock_in and clock_out (deduped by shift)
    const staffResult = await pool.query(
      `SELECT s.*, spd.payment_method, spd.is_verified, spd.is_active as payment_active,
              te.hours_worked, te.total_cost
       FROM staff s
       LEFT JOIN staff_payment_details spd ON s.id = spd.staff_id
       LEFT JOIN (
         WITH deduped AS (
           SELECT DISTINCT ON (te2.staff_id, te2.date, COALESCE(te2.shift_id::text, 'f' || te2.id::text))
             te2.staff_id, te2.clock_in_time, te2.clock_out_time
           FROM time_entries te2
           LEFT JOIN shifts sh ON sh.id = te2.shift_id
           WHERE te2.user_id = $1 AND te2.date BETWEEN $2 AND $3
             AND te2.clock_in_time IS NOT NULL AND te2.clock_out_time IS NOT NULL
             AND te2.entry_type = 'clock_in_out'
             AND (te2.shift_id IS NULL OR sh.clock_source = 'staff')
           ORDER BY te2.staff_id, te2.date, COALESCE(te2.shift_id::text, 'f' || te2.id::text), te2.id DESC
         )
         SELECT d.staff_id,
                SUM(EXTRACT(EPOCH FROM (d.clock_out_time - d.clock_in_time)) / 3600.0) as hours_worked,
                SUM((EXTRACT(EPOCH FROM (d.clock_out_time - d.clock_in_time)) / 3600.0) * s2.hourly_rate) as total_cost
         FROM deduped d
         JOIN staff s2 ON s2.id = d.staff_id AND s2.user_id = $1
         GROUP BY d.staff_id
       ) te ON te.staff_id = s.id
       WHERE s.user_id = $1 AND s.status = 'active'`,
      [req.session.userId, periodStart, periodEnd]
    );

    if (staffResult.rows.length === 0) {
      return res.json({ message: 'No active staff found', payments: [] });
    }

    const payments = [];
    let totalPaid = 0;
    let staffPaid = 0;

    for (const staff of staffResult.rows) {
      if (!staff.payment_method || !staff.payment_active) {
        continue;
      }

      const amount = staff.total_cost || 0;
      if (amount <= 0) {
        continue;
      }

      // Create payment record
      const paymentResult = await pool.query(
        `INSERT INTO payment_history 
         (user_id, staff_id, amount, hours_worked, payment_period_start, payment_period_end,
          payment_method, payment_status, scheduled_date, is_automatic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', CURRENT_DATE, true)
         RETURNING *`,
        [req.session.userId, staff.id, amount, staff.hours_worked || 0, 
         periodStart, periodEnd, staff.payment_method]
      );

      payments.push(paymentResult.rows[0]);
      totalPaid += parseFloat(amount);
      staffPaid++;
    }

    // Log the batch payment
    const schedule = await pool.query(
      'SELECT id FROM payment_schedules WHERE user_id = $1 AND is_active = true',
      [req.session.userId]
    );

    if (schedule.rows.length > 0) {
      await pool.query(
        `INSERT INTO payment_schedule_logs 
         (payment_schedule_id, user_id, execution_date, status, total_staff_paid, total_amount)
         VALUES ($1, $2, CURRENT_DATE, 'success', $3, $4)`,
        [schedule.rows[0].id, req.session.userId, staffPaid, totalPaid]
      );
    }

    res.json({
      message: `Payment initiated for ${staffPaid} staff members`,
      totalAmount: totalPaid,
      staffPaid,
      payments
    });
  } catch (error) {
    console.error('Error processing batch payments:', error);
    res.status(500).json({ error: 'Failed to process payments' });
  }
});

// GET payment history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { status, staffId, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT ph.*, s.name as staff_name, s.email as staff_email
      FROM payment_history ph
      JOIN staff s ON s.id = ph.staff_id
      WHERE ph.user_id = $1
    `;
    const params = [req.session.userId];
    let paramIndex = 2;

    if (status) {
      query += ` AND ph.payment_status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (staffId) {
      query += ` AND ph.staff_id = $${paramIndex}`;
      params.push(staffId);
      paramIndex++;
    }

    query += ` ORDER BY ph.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM payment_history WHERE user_id = $1';
    const countParams = [req.session.userId];
    if (status) countQuery += ` AND payment_status = $2`;
    if (staffId) countQuery += ` AND staff_id = $${status ? 3 : 2}`;
    
    const countResult = await pool.query(countQuery, 
      status && staffId ? [req.session.userId, status, staffId] :
      status ? [req.session.userId, status] :
      staffId ? [req.session.userId, staffId] :
      [req.session.userId]
    );

    res.json({
      payments: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// GET payment statistics
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT 
         COUNT(*) as total_payments,
         SUM(amount) as total_paid,
         COUNT(DISTINCT staff_id) as staff_paid,
         AVG(amount) as average_payment,
         SUM(CASE WHEN payment_status = 'completed' THEN amount ELSE 0 END) as completed_amount,
         SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END) as pending_amount,
         SUM(CASE WHEN payment_status = 'failed' THEN amount ELSE 0 END) as failed_amount
       FROM payment_history
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
      [req.session.userId]
    );

    res.json({ stats: stats.rows[0] });
  } catch (error) {
    console.error('Error fetching payment stats:', error);
    res.status(500).json({ error: 'Failed to fetch payment statistics' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function calculateNextPaymentDate(scheduleType, paymentDay) {
  const today = new Date();
  let nextDate = new Date(today);

  switch (scheduleType) {
    case 'weekly':
      const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const targetDay = daysOfWeek.indexOf(paymentDay);
      const currentDay = today.getDay();
      let daysUntilPayment = targetDay - currentDay;
      if (daysUntilPayment <= 0) daysUntilPayment += 7;
      nextDate.setDate(today.getDate() + daysUntilPayment);
      break;

    case 'bi-weekly':
      const biWeeklyTarget = daysOfWeek.indexOf(paymentDay);
      const biWeeklyDiff = biWeeklyTarget - today.getDay();
      nextDate.setDate(today.getDate() + (biWeeklyDiff <= 0 ? biWeeklyDiff + 14 : biWeeklyDiff));
      break;

    case 'monthly':
      const dayOfMonth = parseInt(paymentDay) || 1;
      nextDate.setDate(dayOfMonth);
      if (nextDate <= today) {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }
      break;

    default:
      nextDate.setDate(today.getDate() + 7); // Default to next week
  }

  return nextDate.toISOString().split('T')[0]; // Return YYYY-MM-DD format
}

export default router;

