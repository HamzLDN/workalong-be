import { pool } from '../lib/db.js';
import { buildNotification } from '../lib/notifications.js';
import { buildPayslipFromEntries } from '../lib/payrollRuns.js';
import { canTransitionLeaveStatus, validateLeaveRequestInput } from '../lib/leaveRequests.js';
import { AVAILABILITY_STATUSES } from '../lib/availability.js';

async function assertStaffOwned(client, staffId, userId) {
  const r = await client.query('SELECT id, name FROM staff WHERE id = $1 AND user_id = $2', [
    staffId,
    userId,
  ]);
  if (!r.rows.length) throw new Error('Staff member not found');
  return r.rows[0];
}

export async function createNotification(userId, { staffId, type, title, body, meta }) {
  const payload = buildNotification({ type, title, body, meta });
  const result = await pool.query(
    `INSERT INTO notifications (user_id, staff_id, type, title, body, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [userId, staffId ?? null, payload.type, payload.title, payload.body, JSON.stringify(meta || {})]
  );
  return result.rows[0];
}

export async function listNotifications(userId, { staffId, unreadOnly, limit = 50 } = {}) {
  const clauses = ['user_id = $1'];
  const params = [userId];
  let i = 2;
  if (staffId != null) {
    clauses.push(`(staff_id = $${i++} OR staff_id IS NULL)`);
    params.push(staffId);
  }
  if (unreadOnly) clauses.push('read_at IS NULL');
  params.push(Math.min(limit, 200));
  const result = await pool.query(
    `SELECT * FROM notifications WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${i}`,
    params
  );
  return result.rows;
}

export async function markNotificationRead(userId, notificationId) {
  const result = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING *`,
    [notificationId, userId]
  );
  return result.rows[0] || null;
}

export async function listAvailability(userId, { staffId, startDate, endDate } = {}) {
  const clauses = ['sa.user_id = $1'];
  const params = [userId];
  let i = 2;
  if (staffId != null) {
    clauses.push(`sa.staff_id = $${i++}`);
    params.push(staffId);
  }
  if (startDate) {
    clauses.push(`(sa.specific_date IS NULL OR sa.specific_date >= $${i++})`);
    params.push(startDate);
  }
  if (endDate) {
    clauses.push(`(sa.specific_date IS NULL OR sa.specific_date <= $${i++})`);
    params.push(endDate);
  }
  const result = await pool.query(
    `SELECT sa.*, s.name AS staff_name
     FROM staff_availability sa
     JOIN staff s ON s.id = sa.staff_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY sa.staff_id, sa.weekday NULLS LAST, sa.specific_date NULLS LAST, sa.start_time`,
    params
  );
  return result.rows;
}

export async function upsertAvailability(userId, staffId, slot) {
  if (!AVAILABILITY_STATUSES.has(slot.status)) throw new Error('Invalid availability status');
  if (!slot.startTime || !slot.endTime) throw new Error('Start and end times are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertStaffOwned(client, staffId, userId);
    const result = await client.query(
      `INSERT INTO staff_availability
       (user_id, staff_id, weekday, specific_date, start_time, end_time, status, is_recurring, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        staffId,
        slot.weekday ?? null,
        slot.specificDate ?? null,
        slot.startTime,
        slot.endTime,
        slot.status,
        slot.isRecurring !== false,
        slot.notes ?? null,
      ]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteAvailability(userId, availabilityId) {
  const result = await pool.query(
    `DELETE FROM staff_availability WHERE id = $1 AND user_id = $2 RETURNING id`,
    [availabilityId, userId]
  );
  return result.rows.length > 0;
}

export async function listLeaveRequests(userId, { staffId, status } = {}) {
  const clauses = ['lr.user_id = $1'];
  const params = [userId];
  let i = 2;
  if (staffId != null) {
    clauses.push(`lr.staff_id = $${i++}`);
    params.push(staffId);
  }
  if (status) {
    clauses.push(`lr.status = $${i++}`);
    params.push(status);
  }
  const result = await pool.query(
    `SELECT lr.*, s.name AS staff_name
     FROM leave_requests lr
     JOIN staff s ON s.id = lr.staff_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY lr.created_at DESC`,
    params
  );
  return result.rows;
}

export async function createLeaveRequest(userId, staffId, data) {
  const err = validateLeaveRequestInput(data);
  if (err) throw new Error(err);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const staff = await assertStaffOwned(client, staffId, userId);
    const result = await client.query(
      `INSERT INTO leave_requests
       (user_id, staff_id, start_date, end_date, category, hours, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [
        userId,
        staffId,
        data.startDate,
        data.endDate,
        data.category || 'paid_leave',
        data.hours ?? 0,
        data.notes ?? null,
      ]
    );
    await createNotification(userId, {
      staffId,
      type: 'leave_submitted',
      title: 'Leave request submitted',
      body: `${staff.name} requested leave ${data.startDate} – ${data.endDate}`,
      meta: { leaveRequestId: result.rows[0].id },
    });
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function reviewLeaveRequest(userId, requestId, { status, reviewNotes, reviewerStaffId }) {
  if (!canTransitionLeaveStatus('pending', status)) {
    throw new Error('Invalid leave status transition');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT lr.*, s.name AS staff_name FROM leave_requests lr
       JOIN staff s ON s.id = lr.staff_id
       WHERE lr.id = $1 AND lr.user_id = $2`,
      [requestId, userId]
    );
    if (!cur.rows.length) throw new Error('Leave request not found');
    const row = cur.rows[0];
    if (row.status !== 'pending') throw new Error('Leave request already reviewed');

    const result = await client.query(
      `UPDATE leave_requests
       SET status = $1, review_notes = $2, reviewer_staff_id = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, reviewNotes ?? null, reviewerStaffId ?? null, requestId]
    );

    await createNotification(userId, {
      staffId: row.staff_id,
      type: status === 'approved' ? 'leave_approved' : 'leave_rejected',
      title: status === 'approved' ? 'Leave approved' : 'Leave rejected',
      body: `Your leave request (${row.start_date} – ${row.end_date}) was ${status}.`,
      meta: { leaveRequestId: requestId },
    });
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDocuments(userId, { staffId } = {}) {
  const clauses = ['d.user_id = $1'];
  const params = [userId];
  if (staffId != null) {
    clauses.push('d.staff_id = $2');
    params.push(staffId);
  }
  const result = await pool.query(
    `SELECT id, user_id, staff_id, doc_type, file_name, mime_type, expires_at, created_at, updated_at
     FROM staff_documents d
     WHERE ${clauses.join(' AND ')}
     ORDER BY expires_at NULLS LAST, created_at DESC`,
    params
  );
  return result.rows;
}

export async function createDocument(userId, staffId, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertStaffOwned(client, staffId, userId);
    const result = await client.query(
      `INSERT INTO staff_documents
       (user_id, staff_id, doc_type, file_name, mime_type, file_data, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, staff_id, doc_type, file_name, mime_type, expires_at, created_at`,
      [
        userId,
        staffId,
        data.docType,
        data.fileName,
        data.mimeType ?? null,
        data.fileData ?? null,
        data.expiresAt ?? null,
      ]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listExpiringDocuments(userId, withinDays = 30) {
  const result = await pool.query(
    `SELECT d.*, s.name AS staff_name
     FROM staff_documents d
     JOIN staff s ON s.id = d.staff_id
     WHERE d.user_id = $1
       AND d.expires_at IS NOT NULL
       AND d.expires_at <= (CURRENT_DATE + $2::int)
     ORDER BY d.expires_at ASC`,
    [userId, withinDays]
  );
  return result.rows;
}

export async function listExpenses(userId, { staffId, status } = {}) {
  const clauses = ['e.user_id = $1'];
  const params = [userId];
  let i = 2;
  if (staffId != null) {
    clauses.push(`e.staff_id = $${i++}`);
    params.push(staffId);
  }
  if (status) {
    clauses.push(`e.status = $${i++}`);
    params.push(status);
  }
  const result = await pool.query(
    `SELECT e.*, s.name AS staff_name
     FROM expenses e JOIN staff s ON s.id = e.staff_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.created_at DESC`,
    params
  );
  return result.rows;
}

export async function createExpense(userId, staffId, data) {
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid expense amount');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const staff = await assertStaffOwned(client, staffId, userId);
    const result = await client.query(
      `INSERT INTO expenses
       (user_id, staff_id, category, amount, expense_date, description, receipt_file_name, receipt_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [
        userId,
        staffId,
        data.category,
        amount,
        data.expenseDate || new Date().toISOString().slice(0, 10),
        data.description ?? null,
        data.receiptFileName ?? null,
        data.receiptData ?? null,
      ]
    );
    await createNotification(userId, {
      staffId,
      type: 'expense_submitted',
      title: 'Expense submitted',
      body: `${staff.name} submitted £${amount.toFixed(2)} (${data.category})`,
      meta: { expenseId: result.rows[0].id },
    });
    await client.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function reviewExpense(userId, expenseId, { status, reviewNotes, reviewerStaffId }) {
  if (!['approved', 'rejected', 'reimbursed'].includes(status)) {
    throw new Error('Invalid expense status');
  }
  const result = await pool.query(
    `UPDATE expenses
     SET status = $1, review_notes = $2, reviewer_staff_id = $3, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $4 AND user_id = $5 AND status IN ('pending','approved')
     RETURNING *`,
    [status, reviewNotes ?? null, reviewerStaffId ?? null, expenseId, userId]
  );
  if (!result.rows.length) throw new Error('Expense not found or not reviewable');
  const row = result.rows[0];
  await createNotification(userId, {
    staffId: row.staff_id,
    type: status === 'rejected' ? 'expense_rejected' : 'expense_approved',
    title: `Expense ${status}`,
    body: `Your expense of £${Number(row.amount).toFixed(2)} was ${status}.`,
    meta: { expenseId },
  });
  return row;
}

export async function createPayrollRun(userId, { periodStart, periodEnd, scheduleType = 'monthly' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRow = await client.query(
      'SELECT pension_employee_percent FROM users WHERE id = $1',
      [userId]
    );
    const pensionPct = Number(userRow.rows[0]?.pension_employee_percent) || 0;

    const runResult = await client.query(
      `INSERT INTO payroll_runs (user_id, period_start, period_end, schedule_type, status)
       VALUES ($1, $2, $3, $4, 'draft')
       RETURNING *`,
      [userId, periodStart, periodEnd, scheduleType]
    );
    const run = runResult.rows[0];

    const staffRows = await client.query(
      `SELECT id, name, hourly_rate FROM staff WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );

    let totalGross = 0;
    const payslips = [];

    for (const st of staffRows.rows) {
      const entries = await client.query(
        `SELECT te.date, te.hours_worked, te.overtime_hours, te.leave_category, st.hourly_rate
         FROM time_entries te
         JOIN staff st ON st.id = te.staff_id
         WHERE te.user_id = $1 AND te.staff_id = $2
           AND te.date >= $3 AND te.date <= $4
           AND (te.approved_at IS NOT NULL OR te.entry_type IN ('manual','approved_shift'))`,
        [userId, st.id, periodStart, periodEnd]
      );
      const payslip = buildPayslipFromEntries(entries.rows, {
        pensionEmployeePercent: pensionPct,
      });
      totalGross += payslip.grossPay;
      const ins = await client.query(
        `INSERT INTO payslips (payroll_run_id, user_id, staff_id, gross_pay, net_pay, hours_worked, line_items)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING *`,
        [
          run.id,
          userId,
          st.id,
          payslip.grossPay,
          payslip.netPay,
          payslip.hoursWorked,
          JSON.stringify(payslip.lineItems),
        ]
      );
      payslips.push(ins.rows[0]);
      await createNotification(userId, {
        staffId: st.id,
        type: 'payslip_ready',
        title: 'Payslip ready',
        body: `Your payslip for ${periodStart} – ${periodEnd} is ready.`,
        meta: { payslipId: ins.rows[0].id, payrollRunId: run.id },
      });
    }

    const updated = await client.query(
      `UPDATE payroll_runs SET total_gross = $1, status = 'finalized', updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [totalGross, run.id]
    );

    await client.query('COMMIT');
    return { run: updated.rows[0], payslips };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listPayrollRuns(userId) {
  const result = await pool.query(
    `SELECT * FROM payroll_runs WHERE user_id = $1 ORDER BY period_start DESC`,
    [userId]
  );
  return result.rows;
}

export async function getPayslipsForRun(userId, runId) {
  const result = await pool.query(
    `SELECT p.*, s.name AS staff_name
     FROM payslips p JOIN staff s ON s.id = p.staff_id
     WHERE p.user_id = $1 AND p.payroll_run_id = $2
     ORDER BY s.name`,
    [userId, runId]
  );
  return result.rows;
}

export async function publishRotaWeek(userId, weekStart, publishedByUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pub = await client.query(
      `INSERT INTO rota_publishes (user_id, week_start, published_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, week_start)
       DO UPDATE SET published_at = NOW(), published_by_user_id = EXCLUDED.published_by_user_id
       RETURNING *`,
      [userId, weekStart, publishedByUserId ?? userId]
    );
    await client.query(
      `UPDATE shifts SET published_at = NOW()
       WHERE user_id = $1 AND shift_date >= $2::date AND shift_date < ($2::date + INTERVAL '7 days')`,
      [userId, weekStart]
    );
    const staffRows = await client.query('SELECT id FROM staff WHERE user_id = $1 AND status = $2', [
      userId,
      'active',
    ]);
    for (const s of staffRows.rows) {
      await createNotification(userId, {
        staffId: s.id,
        type: 'rota_published',
        title: 'Rota published',
        body: `The rota for week starting ${weekStart} has been published.`,
        meta: { weekStart },
      });
    }
    await client.query('COMMIT');
    return pub.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getSchedulingInsights(userId, { startDate, endDate }) {
  const shifts = await pool.query(
    `SELECT s.id, s.staff_id, s.shift_date, s.start_time, s.hours, st.name AS staff_name, st.hourly_rate
     FROM shifts s JOIN staff st ON st.id = s.staff_id
     WHERE s.user_id = $1 AND s.shift_date >= $2 AND s.shift_date <= $3 AND s.status != 'cancelled'`,
    [userId, startDate, endDate]
  );
  const availability = await listAvailability(userId, { startDate, endDate });
  const { detectUnavailableStaffOnShift, resolveAvailabilityForShift } = await import(
    '../lib/availability.js'
  );

  const byDate = {};
  for (const sh of shifts.rows) {
    const dateKey = String(sh.shift_date).slice(0, 10);
    if (!byDate[dateKey]) byDate[dateKey] = { shiftCount: 0, staffIds: new Set(), conflicts: [] };
    byDate[dateKey].shiftCount += 1;
    byDate[dateKey].staffIds.add(sh.staff_id);

    const staffSlots = availability.filter((a) => a.staff_id === sh.staff_id);
    const endTime = sh.start_time; // simplified end for overlap check
    const shift = {
      shiftDate: dateKey,
      startTime: String(sh.start_time).slice(0, 5),
      endTime: String(sh.start_time).slice(0, 5),
    };
    const slots = staffSlots.map((a) => ({
      ...a,
      start_time: String(a.start_time).slice(0, 5),
      end_time: String(a.end_time).slice(0, 5),
    }));
    if (detectUnavailableStaffOnShift(slots, shift)) {
      byDate[dateKey].conflicts.push({
        shiftId: sh.id,
        staffName: sh.staff_name,
        reason: 'Staff marked unavailable or on holiday',
      });
    }
    const resolved = resolveAvailabilityForShift(slots, shift);
    if (resolved.status === 'not_set') {
      byDate[dateKey].conflicts.push({
        shiftId: sh.id,
        staffName: sh.staff_name,
        reason: 'No availability set',
      });
    }
  }

  const understaffed = Object.entries(byDate)
    .filter(([, v]) => v.shiftCount < 2)
    .map(([date, v]) => ({ date, shiftCount: v.shiftCount }));

  const overtimeCostEstimate = shifts.rows.reduce((sum, sh) => {
    const hrs = Number(sh.hours) || 0;
    const rate = Number(sh.hourly_rate) || 0;
    return sum + Math.max(0, hrs - 8) * rate * 0.5;
  }, 0);

  return {
    period: { startDate, endDate },
    totalShifts: shifts.rows.length,
    understaffedDays: understaffed,
    schedulingConflicts: Object.values(byDate).flatMap((d) => d.conflicts),
    estimatedOvertimeCost: Math.round(overtimeCostEstimate * 100) / 100,
  };
}
