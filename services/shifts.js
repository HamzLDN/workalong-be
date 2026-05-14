import { pool } from '../lib/db.js';
import { sanitizeString } from '../lib/sanitize.js';
import fs from 'fs';

/** Rejects objects/arrays; ensures a single finite positive integer for DB bigint columns. */
function coercePositiveIntId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const n = typeof value === 'string' ? parseInt(String(value).trim(), 10) : Number(value);
  if (!Number.isFinite(n) || n < 1 || n !== Math.trunc(n)) return null;
  return n;
}

/**
 * Normalise Postgres TIME / pg driver variants → `HH:mm:ss` for end-time modulo math.
 * Returns null only when nothing parseable remains (caller should skip auto-status updates).
 */
function coerceShiftStartTimeString(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    // pg sometimes represents TIME columns as JS Date anchored at 1970-01-01 in UTC.
    const h = raw.getUTCHours();
    const m = raw.getUTCMinutes();
    const s = raw.getUTCSeconds();
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!str) return null;
  // ISO datetime fragments (e.g. "1970-01-01T09:05:06.789Z"), or bare "HH:mm[:ss]".
  let m = str.match(/T(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (!m) m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (!m) return null;
  const hh = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const ss = (m[3] ?? '00').padStart(2, '0');
  const h = Number.parseInt(hh, 10);
  const mn = Number.parseInt(mm, 10);
  const sc = Number.parseInt(ss, 10);
  if (!Number.isFinite(h) || !Number.isFinite(mn) || !Number.isFinite(sc)) return null;
  return `${hh}:${mm}:${ss}`;
}

export const INVALID_STAFF_ID = 'INVALID_STAFF_ID';

export function calculateEndTime(startTime, hours) {
  const token = coerceShiftStartTimeString(startTime) ?? '00:00:00';
  let hm =
    typeof hours === 'number' && Number.isFinite(hours)
      ? hours
      : hours == null || hours === ''
        ? 0
        : Number.parseFloat(String(hours));
  if (!Number.isFinite(hm)) hm = 0;
  const parts = token.split(':').map((x) => Number.parseInt(String(x ?? '0').replace(/\..*$/, ''), 10));
  const startHour = Number.isFinite(parts[0]) ? parts[0] : 0;
  const startMin = Number.isFinite(parts[1]) ? parts[1] : 0;
  const totalMinutes = startHour * 60 + startMin + hm * 60;
  const endMinutes = totalMinutes % (24 * 60);
  const endHour = Math.floor(endMinutes / 60);
  const endMin = endMinutes % 60;
  return `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00`;
}

/** Portal / schedule use ~3 minutes beyond scheduled as overtime threshold (hours). */
const OT_EPS_HOURS = 3 / 60;

/**
 * Label whether overtime beyond scheduled hours is paid after approvals (for roster UI).
 * @returns {'awaiting_head_office_ot'|'scheduled_only_no_ot_pay'|'overtime_accepted_payroll'|null}
 */
export function deriveClockPeriodOvertimePayrollHint(teRow) {
  const notes = String(teRow.notes ?? '');
  const scheduledOnlyNote =
    /scheduled hours only/i.test(notes) &&
    (/overtime not paid/i.test(notes) || /\[portal\]/i.test(notes));

  const approved = !!teRow.approved_at;
  const staffRec = !!teRow.staff_approved_at;
  const sched =
    teRow.shift_scheduled_hours != null ? parseFloat(teRow.shift_scheduled_hours) : null;
  const clockH = parseFloat(Number(teRow.hours_worked ?? 0).toFixed(6));
  const oh = parseFloat(teRow.overtime_hours ?? 0) || 0;

  const schedOk = sched != null && Number.isFinite(sched);
  const hadClockOt = schedOk && clockH > sched + OT_EPS_HOURS;

  if (!approved && staffRec && hadClockOt) {
    return 'awaiting_head_office_ot';
  }

  if (!approved) return null;

  if (scheduledOnlyNote) {
    return 'scheduled_only_no_ot_pay';
  }

  if (hadClockOt && (oh > 0 || !scheduledOnlyNote)) {
    return 'overtime_accepted_payroll';
  }

  return null;
}

/** `{ startMs, endMs }` in epoch ms — same semantics as GET /shifts roster windows (`timezoneOffset`). */
export function shiftScheduledWindowTimestamps(row, tzOffset) {
  let shiftDateStr;
  if (row.shift_date instanceof Date && !Number.isNaN(row.shift_date.getTime())) {
    // node-pg may represent Postgres DATE such that UTC-midnight from toISOString() is the wrong calendar day.
    // en-CA yields YYYY-MM-DD in local calendar for that instant (matches kiosk wall dates).
    shiftDateStr = row.shift_date.toLocaleDateString('en-CA');
  } else if (typeof row.shift_date === 'string') {
    shiftDateStr = row.shift_date.split('T')[0];
  } else {
    shiftDateStr = row.shift_date;
  }
  const token = coerceShiftStartTimeString(row.start_time);
  if (!token || !shiftDateStr || typeof shiftDateStr !== 'string') {
    return null;
  }
  const [y, m, d] = shiftDateStr.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const startParts = token.split(':').map((x) => Number.parseInt(String(x ?? '0').replace(/\..*$/, ''), 10));
  const sh = Number.isFinite(startParts[0]) ? startParts[0] : 0;
  const sm = Number.isFinite(startParts[1]) ? startParts[1] : 0;
  const ss = Number.isFinite(startParts[2]) ? startParts[2] : 0;

  const calculatedEndTime = calculateEndTime(row.start_time, row.hours);
  const endTime = calculatedEndTime.split(':').map((x) => Number.parseInt(String(x ?? '0').replace(/\..*$/, ''), 10));
  const eh = Number.isFinite(endTime[0]) ? endTime[0] : 0;
  const em = Number.isFinite(endTime[1]) ? endTime[1] : 0;
  const es = Number.isFinite(endTime[2]) ? endTime[2] : 0;

  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const isOvernight = endMins <= startMins;

  const endDay = d + (isOvernight ? 1 : 0);

  let shiftStartTimestamp;
  let shiftEndTimestamp;
  if (tzOffset != null && !isNaN(tzOffset)) {
    const offsetMs = tzOffset * 60 * 1000;
    shiftStartTimestamp = Date.UTC(y, m - 1, d, sh, sm, ss) + offsetMs;
    shiftEndTimestamp = Date.UTC(y, m - 1, endDay, eh, em, es) + offsetMs;
  } else {
    const shiftDate = new Date(`${shiftDateStr}T00:00:00`);
    const shiftStart = new Date(
      shiftDate.getFullYear(),
      shiftDate.getMonth(),
      shiftDate.getDate(),
      sh,
      sm,
      ss
    );
    const shiftEnd = new Date(
      shiftDate.getFullYear(),
      shiftDate.getMonth(),
      shiftDate.getDate() + (isOvernight ? 1 : 0),
      eh,
      em,
      es
    );
    shiftStartTimestamp = shiftStart.getTime();
    shiftEndTimestamp = shiftEnd.getTime();
  }
  return { startMs: shiftStartTimestamp, endMs: shiftEndTimestamp };
}

/**
 * Promote shifts that still say scheduled/late but already have closed clock periods on time_entries
 * and the roster window has passed — keeps UI aligned when TE was updated without touching shifts.
 */
async function syncScheduledShiftsWithCompletedClockEntries(
  rows,
  clockPeriodsByShift,
  nowTimestamp,
  tzOffset
) {
  const pending = [];

  for (const row of rows) {
    if (row.status === 'approved' || row.approved_at) continue;
    if (row.status !== 'scheduled' && row.status !== 'late') continue;

    const periods = clockPeriodsByShift[row.id];
    if (!periods?.length) continue;

    let win;
    try {
      win = shiftScheduledWindowTimestamps(row, tzOffset);
    } catch (err) {
      console.error(`[getShifts] TE sync: shift window timestamps failed (${row?.id}):`, err.message);
      continue;
    }
    if (!win || nowTimestamp <= win.endMs) continue;

    const allClosed = periods.every((p) => p.clock_in_time && p.clock_out_time);
    if (!allClosed) continue;

    const ins = periods.map((p) => new Date(p.clock_in_time).getTime());
    const outs = periods.map((p) => new Date(p.clock_out_time).getTime());
    if (ins.some((t) => !Number.isFinite(t)) || outs.some((t) => !Number.isFinite(t))) continue;

    const firstIn = new Date(Math.min(...ins));
    const lastOut = new Date(Math.max(...outs));

    pending.push({ id: row.id, firstIn, lastOut });
  }

  if (pending.length === 0) return;

  await Promise.all(
    pending.map((p) =>
      pool
        .query(
          `UPDATE shifts SET
             status = 'review_hours',
             clocked_in_time = COALESCE(clocked_in_time, $2),
             clocked_out_time = COALESCE(clocked_out_time, $3),
             clock_source = CASE
               WHEN clock_source IS NULL OR TRIM(BOTH FROM COALESCE(clock_source, '')) = '' THEN 'staff'
               ELSE clock_source
             END,
             updated_at = NOW()
           WHERE id = $1
             AND status IN ('scheduled', 'late')
             AND approved_at IS NULL`,
          [p.id, p.firstIn, p.lastOut]
        )
        .catch((err) =>
          console.error(`[getShifts] sync TE→shift status failed for shift ${p.id}:`, err.message)
        )
    )
  );

  const ids = pending.map((p) => p.id);
  const refreshed = await pool.query(
    `SELECT id, status, clocked_in_time, clocked_out_time FROM shifts WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  const map = Object.fromEntries(refreshed.rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const u = map[row.id];
    if (!u) continue;
    row.status = u.status;
    row.clocked_in_time = u.clocked_in_time;
    row.clocked_out_time = u.clocked_out_time;
  }
}

export async function getShifts(userId, filters = {}) {
  let query = `
    SELECT 
      s.id,
      s.user_id,
      s.staff_id,
      s.created_by_user_id,
      s.created_by_staff_id,
      CASE
        WHEN s.created_by_staff_id IS NOT NULL THEN
          NULLIF(
            TRIM(
              CONCAT(
                COALESCE(shift_creator_staff.name, ''),
                ' ',
                COALESCE(shift_creator_staff.lastname, '')
              )
            ),
            ''
          )
        WHEN s.created_by_user_id IS NOT NULL THEN
          COALESCE(NULLIF(TRIM(shift_creator_user.name), ''), shift_creator_user.email)
        ELSE COALESCE(NULLIF(TRIM(account_user.name), ''), account_user.email)
      END AS created_by_label,
      s.shift_date::text as shift_date,
      s.start_time,
      s.hours,
      s.break_minutes,
      s.shift_type,
      s.pay_type,
      s.status,
      s.location,
      s.notes,
      s.created_at,
      s.updated_at,
      s.approved_at,
      s.approved_by,
      COALESCE(NULLIF(TRIM(approver.name), ''), approver.email) AS approved_by_user_name,
      s.time_entry_id,
      s.clocked_in_time,
      s.clocked_out_time,
      s.clock_source,
      (COALESCE(
        NULLIF((SELECT SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0) FROM time_entries te WHERE te.shift_id = s.id AND te.entry_type = 'clock_in_out' AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL), 0),
        NULLIF((SELECT SUM((COALESCE(te.hours_worked, 0)::numeric + COALESCE(te.overtime_hours, 0)::numeric)) FROM time_entries te WHERE te.shift_id = s.id AND te.entry_type = 'approved_shift'), 0),
        CASE WHEN s.clocked_in_time IS NOT NULL AND s.clocked_out_time IS NOT NULL THEN EXTRACT(EPOCH FROM (s.clocked_out_time - s.clocked_in_time)) / 3600.0 ELSE 0 END
      ))::numeric(10,2) as actual_hours_worked,
      (SELECT NULLIF(TRIM(SUBSTRING(te.notes FROM 'Late clock-out reason: (.+)')), '')
       FROM time_entries te
       WHERE te.shift_id = s.id AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
         AND te.notes IS NOT NULL AND te.notes LIKE 'Late clock-out reason:%'
       ORDER BY te.clock_out_time DESC LIMIT 1) as late_clock_out_reason,
      st.name as staff_name,
      st.role,
      st.hourly_rate
    FROM shifts s
    JOIN staff st ON s.staff_id = st.id
    LEFT JOIN users approver ON approver.id = s.approved_by
    LEFT JOIN users shift_creator_user ON shift_creator_user.id = s.created_by_user_id
    LEFT JOIN staff shift_creator_staff ON shift_creator_staff.id = s.created_by_staff_id
    LEFT JOIN users account_user ON account_user.id = s.user_id
    WHERE s.user_id = $1
  `;

  const params = [userId];
  let paramCount = 1;

  if (filters.startDate) {
    paramCount++;
    query += ` AND s.shift_date >= $${paramCount}`;
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    paramCount++;
    query += ` AND s.shift_date <= $${paramCount}`;
    params.push(filters.endDate);
  }

  if (filters.staffId) {
    paramCount++;
    query += ` AND s.staff_id = $${paramCount}`;
    params.push(filters.staffId);
  }

  if (filters.status) {
    paramCount++;
    query += ` AND s.status = $${paramCount}`;
    params.push(filters.status);
  }

  if (filters.managerStaffId != null && filters.managerStaffId !== '') {
    const mid =
      typeof filters.managerStaffId === 'number'
        ? filters.managerStaffId
        : parseInt(String(filters.managerStaffId), 10);
    if (!Number.isNaN(mid)) {
      paramCount++;
      query += ` AND st.manager_id = $${paramCount}`;
      params.push(mid);
    }
  }

  query += ' ORDER BY s.shift_date, s.start_time';

  const result = await pool.query(query, params);

  const nowTimestamp =
    filters.clientNow != null && !isNaN(parseInt(filters.clientNow, 10))
      ? parseInt(filters.clientNow, 10)
      : Date.now();
  const now = new Date(nowTimestamp);
  const updatePromises = [];
  const tzOffset = filters.timezoneOffset != null ? parseInt(filters.timezoneOffset, 10) : null;

  console.log(
    `[getShifts] Processing ${result.rows.length} shifts (clientNow: ${!!filters.clientNow}, tzOffset: ${tzOffset})`
  );

  const shiftIdsAll = result.rows.map((r) => r.id);
  let clockPeriodsByShift = {};
  if (shiftIdsAll.length > 0) {
    const teResult = await pool.query(
      `SELECT te.id, te.shift_id, te.clock_in_time, te.clock_out_time, te.approved_at, te.approved_by,
              te.staff_approved_at, te.staff_approved_by,
              te.overtime_hours, te.notes,
              EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0 as hours_worked,
              sh.hours AS shift_scheduled_hours,
              COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS approved_by_user_name,
              NULLIF(TRIM(CONCAT(sa.name, ' ', COALESCE(sa.lastname, ''))), '') AS staff_approved_by_name
       FROM time_entries te
       LEFT JOIN shifts sh ON sh.id = te.shift_id
       LEFT JOIN users u ON u.id = te.approved_by
       LEFT JOIN staff sa ON sa.id = te.staff_approved_by
       WHERE te.shift_id = ANY($1::bigint[])
         AND te.entry_type = 'clock_in_out'
         AND te.clock_in_time IS NOT NULL
         AND te.clock_out_time IS NOT NULL
       ORDER BY te.shift_id, te.clock_in_time`,
      [shiftIdsAll]
    );
    for (const row of teResult.rows ?? []) {
      if (!clockPeriodsByShift[row.shift_id]) clockPeriodsByShift[row.shift_id] = [];
      const overtime_payroll_hint = deriveClockPeriodOvertimePayrollHint(row);
      clockPeriodsByShift[row.shift_id].push({
        id: row.id,
        clock_in_time: row.clock_in_time,
        clock_out_time: row.clock_out_time,
        hours_worked: parseFloat(Number(row.hours_worked).toFixed(2)),
        overtime_hours:
          row.overtime_hours != null ? parseFloat(Number(row.overtime_hours).toFixed(4)) : 0,
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        approved_by_user_name: row.approved_by_user_name || null,
        staff_approved_at: row.staff_approved_at,
        staff_approved_by: row.staff_approved_by,
        staff_approved_by_name: row.staff_approved_by_name || null,
        overtime_payroll_hint,
      });
    }
  }

  await syncScheduledShiftsWithCompletedClockEntries(
    result.rows,
    clockPeriodsByShift,
    nowTimestamp,
    tzOffset
  );

  for (const row of result.rows) {
    if (row.status === 'approved' || row.approved_at) {
      continue;
    }
    // Correct wrongly marked 'completed' shifts that have no clock-in (e.g. 24hr shift bug)
    if (row.status === 'completed' && !row.clocked_in_time) {
      console.log(
        `[getShifts] Correcting shift ${row.id}: status=completed but no clock-in → unattended`
      );
      updatePromises.push(
        pool
          .query(`UPDATE shifts SET status = 'unattended', updated_at = NOW() WHERE id = $1`, [
            row.id,
          ])
          .then((r) => {
            if (r.rowCount > 0) row.status = 'unattended';
          })
      );
      continue;
    }
    if (row.status === 'completed') {
      continue;
    }

    if (row.clocked_in_time && !row.clocked_out_time) {
      console.log(
        `[getShifts] Skipping auto-update for shift ${row.id} - currently clocked in (overnight shift in progress)`
      );
      continue;
    }

    try {
      const win = shiftScheduledWindowTimestamps(row, tzOffset);

      const shiftStartTimestamp = win.startMs;
      const shiftEndTimestamp = win.endMs;

      const hasClockIn = row.clocked_in_time && row.clocked_in_time !== null;

      if (nowTimestamp > shiftEndTimestamp && !row.clocked_in_time) {
        const hasClosedClockEntries = (clockPeriodsByShift[row.id] || []).length > 0;
        if (hasClosedClockEntries) {
          continue;
        }
        // No clock-in = no one attended → always unattended (never completed)
        const newStatus = 'unattended';

        console.log(
          `[getShifts] Auto-marking shift ${row.id} as ${newStatus} (ended at ${new Date(shiftEndTimestamp).toISOString()}, now is ${now.toISOString()}, no clock-in recorded)`
        );
        updatePromises.push(
          pool
            .query(
              `UPDATE shifts SET status = $1, updated_at = NOW() WHERE id = $2 AND status IN ('scheduled', 'late')`,
              [newStatus, row.id]
            )
            .then((result) => {
              if (result.rowCount > 0) {
                console.log(`[getShifts] Successfully marked shift ${row.id} as ${newStatus}`);
              } else {
                console.log(
                  `[getShifts] Shift ${row.id} was not updated (may have been updated concurrently)`
                );
              }
            })
            .catch((err) => {
              console.error(`[getShifts] Error updating shift ${row.id}:`, err);
            })
        );
        row.status = newStatus;
      } else if (
        nowTimestamp > shiftStartTimestamp &&
        nowTimestamp < shiftEndTimestamp &&
        !hasClockIn
      ) {
        console.log(
          `[getShifts] Auto-marking shift ${row.id} as late (started at ${new Date(shiftStartTimestamp).toISOString()}, now is ${now.toISOString()}, no clock-in)`
        );
        updatePromises.push(
          pool
            .query(
              `UPDATE shifts SET status = 'late', updated_at = NOW() WHERE id = $1 AND status IN ('scheduled', 'unattended')`,
              [row.id]
            )
            .then((result) => {
              if (result.rowCount > 0) {
                console.log(`[getShifts] Successfully marked shift ${row.id} as late`);
              } else {
                console.log(
                  `[getShifts] Shift ${row.id} was not updated to late (may have been updated concurrently)`
                );
              }
            })
            .catch((err) => {
              console.error(`[getShifts] Error updating shift ${row.id} to late:`, err);
            })
        );
        row.status = 'late';
      }
    } catch (err) {
      console.error(`[getShifts] Error processing shift ${row.id} for auto-completion:`, err);
    }
  }

  if (updatePromises.length > 0) {
    console.log(
      `[getShifts] Executing ${updatePromises.length} status update(s) before returning data`
    );
    await Promise.all(updatePromises).catch((err) => {
      console.error('[getShifts] Error auto-updating shift statuses:', err);
    });
    console.log(`[getShifts] All status updates completed`);
  }

  if (updatePromises.length > 0) {
    const updatedShiftIds = [];
    for (const row of result.rows) {
      if (row.status === 'completed' || row.status === 'unattended' || row.status === 'late') {
        updatedShiftIds.push(row.id);
      }
    }

    if (updatedShiftIds.length > 0) {
      const statusResult = await pool.query(
        `SELECT id, status FROM shifts WHERE id = ANY($1::bigint[])`,
        [updatedShiftIds]
      );

      const statusMap = {};
      statusResult.rows.forEach((s) => {
        statusMap[s.id] = s.status;
      });

      result.rows.forEach((row) => {
        if (statusMap[row.id]) {
          row.status = statusMap[row.id];
        }
      });
    }
  }

  return result.rows.map((shift) => {
    const cleaned = { ...shift };
    cleaned.clocked_in_time =
      shift.clocked_in_time === null ||
      shift.clocked_in_time === undefined ||
      shift.clocked_in_time === ''
        ? null
        : shift.clocked_in_time;
    cleaned.clocked_out_time =
      shift.clocked_out_time === null ||
      shift.clocked_out_time === undefined ||
      shift.clocked_out_time === ''
        ? null
        : shift.clocked_out_time;
    cleaned.actual_hours_worked =
      shift.actual_hours_worked != null ? parseFloat(shift.actual_hours_worked) : 0;
    cleaned.clock_periods = clockPeriodsByShift[shift.id] || [];
    // Normalize shift_date to YYYY-MM-DD format (PostgreSQL DATE returns as Date object or string)
    if (shift.shift_date instanceof Date) {
      // Convert Date object to YYYY-MM-DD string using local timezone
      const year = shift.shift_date.getFullYear();
      const month = String(shift.shift_date.getMonth() + 1).padStart(2, '0');
      const day = String(shift.shift_date.getDate()).padStart(2, '0');
      cleaned.shift_date = `${year}-${month}-${day}`;
    } else if (typeof shift.shift_date === 'string') {
      cleaned.shift_date = shift.shift_date.split('T')[0];
    }
    cleaned.end_time =
      shift.start_time != null && String(shift.start_time).trim() !== ''
        ? calculateEndTime(shift.start_time, shift.hours)
        : null;
    return cleaned;
  });
}

export async function getShiftById(shiftId, userId) {
  const result = await pool.query(
    `SELECT s.*,
            s.shift_date::text as shift_date,
            st.name as staff_name,
            st.role,
            st.hourly_rate,
            s.created_by_user_id,
            s.created_by_staff_id,
            CASE
              WHEN s.created_by_staff_id IS NOT NULL THEN
                NULLIF(
                  TRIM(
                    CONCAT(
                      COALESCE(shift_creator_staff.name, ''),
                      ' ',
                      COALESCE(shift_creator_staff.lastname, '')
                    )
                  ),
                  ''
                )
              WHEN s.created_by_user_id IS NOT NULL THEN
                COALESCE(NULLIF(TRIM(shift_creator_user.name), ''), shift_creator_user.email)
              ELSE COALESCE(NULLIF(TRIM(account_user.name), ''), account_user.email)
            END AS created_by_label,
            COALESCE(NULLIF(TRIM(appr.name), ''), appr.email) AS approved_by_user_name
     FROM shifts s
     JOIN staff st ON s.staff_id = st.id
     LEFT JOIN users appr ON appr.id = s.approved_by
     LEFT JOIN users shift_creator_user ON shift_creator_user.id = s.created_by_user_id
     LEFT JOIN staff shift_creator_staff ON shift_creator_staff.id = s.created_by_staff_id
     LEFT JOIN users account_user ON account_user.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [shiftId, userId]
  );

  if (result.rows[0]) {
    const shift = result.rows[0];
    if (shift.shift_date) {
      shift.shift_date = shift.shift_date.split('T')[0];
    }
  }

  return result.rows[0];
}

export async function createShift(userId, data, options = {}) {
  const { createdByUserId = null, createdByStaffId = null } = options;
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
  } = data;

  const staffIdNum = coercePositiveIntId(staffId);
  if (staffIdNum === null) {
    throw new Error(INVALID_STAFF_ID);
  }

  // Verify that the staff member belongs to this user
  const staffCheck = await pool.query('SELECT id FROM staff WHERE id = $1 AND user_id = $2', [
    staffIdNum,
    userId,
  ]);

  if (staffCheck.rows.length === 0) {
    throw new Error('Staff member not found or does not belong to this user');
  }

  const normalizedDate = shiftDate.split('T')[0];
  console.log('[createShift] Creating shift with date:', normalizedDate, 'original:', shiftDate);

  const shiftHours = parseFloat(hours) || 0;
  const calculatedEndTime = calculateEndTime(startTime, shiftHours);

  // Sanitize string fields to remove null bytes
  const sanitizedLocation = location ? sanitizeString(location) : location;
  const sanitizedNotes = notes ? sanitizeString(notes) : notes;

  const result = await pool.query(
    `INSERT INTO shifts (
      user_id, staff_id, shift_date, start_time, hours, 
      break_minutes, shift_type, pay_type, location, notes,
      created_by_user_id, created_by_staff_id
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
    RETURNING *`,
    [
      userId,
      staffIdNum,
      normalizedDate, // Use normalized date
      startTime,
      shiftHours,
      breakMinutes || 0,
      shiftType || 'regular',
      payType || 'regular',
      sanitizedLocation,
      sanitizedNotes,
      createdByUserId,
      createdByStaffId,
    ]
  );

  console.log('[createShift] Shift created in DB. shift_date:', result.rows[0].shift_date);
  return result.rows[0];
}

export async function updateShift(shiftId, userId, data) {
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
  } = data;

  const shiftHours = hours !== undefined ? parseFloat(hours) : undefined;

  const updates = [];
  const values = [];
  let paramCount = 1;

  if (staffId !== undefined) {
    const staffIdNum = coercePositiveIntId(staffId);
    if (staffIdNum === null) {
      throw new Error(INVALID_STAFF_ID);
    }
    updates.push(`staff_id = $${paramCount++}`);
    values.push(staffIdNum);
  }
  if (shiftDate !== undefined) {
    updates.push(`shift_date = $${paramCount++}`);
    values.push(shiftDate);
  }
  if (startTime !== undefined) {
    updates.push(`start_time = $${paramCount++}`);
    values.push(startTime);
  }
  if (shiftHours !== undefined) {
    updates.push(`hours = $${paramCount++}`);
    values.push(shiftHours);
  }
  if (breakMinutes !== undefined) {
    updates.push(`break_minutes = $${paramCount++}`);
    values.push(breakMinutes);
  }
  if (shiftType !== undefined) {
    updates.push(`shift_type = $${paramCount++}`);
    values.push(shiftType);
  }
  if (payType !== undefined) {
    console.log(`[updateShift] payType is defined: ${payType} for shift ${shiftId}`);
    updates.push(`pay_type = $${paramCount++}`);
    values.push(payType);
  } else {
    console.log(`[updateShift] payType is undefined for shift ${shiftId}`);
  }
  if (status !== undefined) {
    updates.push(`status = $${paramCount++}`);
    values.push(status);
  }
  if (location !== undefined) {
    updates.push(`location = $${paramCount++}`);
    values.push(location ? sanitizeString(location) : location);
  }
  if (notes !== undefined) {
    updates.push(`notes = $${paramCount++}`);
    values.push(notes ? sanitizeString(notes) : notes);
  }
  if (clockedInTime !== undefined || clockedOutTime !== undefined) {
    updates.push(`clock_source = 'manager'`);
  }
  if (clockedInTime !== undefined) {
    updates.push(`clocked_in_time = $${paramCount++}`);
    values.push(clockedInTime);
  }
  if (clockedOutTime !== undefined) {
    updates.push(`clocked_out_time = $${paramCount++}`);
    values.push(clockedOutTime);
  }

  if (updates.length === 0) {
    throw new Error('No fields to update');
  }

  updates.push(`updated_at = NOW()`);

  values.push(shiftId);
  values.push(userId);

  console.log(`[updateShift] Updating shift ${shiftId} with fields: ${updates.join(', ')}`);
  console.log(`[updateShift] Values:`, values.slice(0, -2)); // Exclude shiftId and userId from log

  const result = await pool.query(
    `UPDATE shifts 
     SET ${updates.join(', ')}
     WHERE id = $${paramCount++} AND user_id = $${paramCount}
     RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    console.error(`[updateShift] No shift found with id ${shiftId} for user ${userId}`);
    return null;
  }

  const updatedShift = result.rows[0];

  // Sync clock times to time_entries so display and monthly payroll reflect the change
  if (clockedInTime !== undefined && clockedOutTime !== undefined) {
    const teResult = await pool.query(
      `SELECT id, clock_in_time, clock_out_time FROM time_entries
       WHERE shift_id = $1 AND user_id = $2 AND entry_type = 'clock_in_out'
         AND clock_in_time IS NOT NULL AND clock_out_time IS NOT NULL
       ORDER BY clock_in_time ASC`,
      [shiftId, userId]
    );
    const entries = teResult.rows;
    if (entries.length === 1) {
      const hoursDiff = (new Date(clockedOutTime) - new Date(clockedInTime)) / (1000 * 60 * 60);
      const hoursWorked = Math.round(Math.max(0, hoursDiff) * 100) / 100;
      const isApproved = updatedShift.status === 'approved';
      await pool.query(
        `UPDATE time_entries SET clock_in_time = $1, clock_out_time = $2, hours_worked = $3, updated_at = NOW()${isApproved ? ', approved_at = NOW(), approved_by = $5' : ''}
         WHERE id = $4`,
        isApproved
          ? [clockedInTime, clockedOutTime, hoursWorked, entries[0].id, userId]
          : [clockedInTime, clockedOutTime, hoursWorked, entries[0].id]
      );
      console.log(
        `[updateShift] Synced clock times to time_entry ${entries[0].id} for payroll${isApproved ? ' (approved)' : ''}`
      );
    } else if (entries.length > 1) {
      // Multiple periods: update first entry's clock_in and last entry's clock_out
      await pool.query(
        `UPDATE time_entries SET clock_in_time = $1, updated_at = NOW() WHERE id = $2`,
        [clockedInTime, entries[0].id]
      );
      await pool.query(
        `UPDATE time_entries SET clock_out_time = $1, updated_at = NOW() WHERE id = $2`,
        [clockedOutTime, entries[entries.length - 1].id]
      );
      // Recalc hours_worked for first and last entries
      const firstOut = new Date(entries[0].clock_out_time);
      const firstIn = new Date(clockedInTime);
      const firstHours =
        Math.round(Math.max(0, (firstOut - firstIn) / (1000 * 60 * 60)) * 100) / 100;
      await pool.query(`UPDATE time_entries SET hours_worked = $1 WHERE id = $2`, [
        firstHours,
        entries[0].id,
      ]);
      const lastIn = new Date(entries[entries.length - 1].clock_in_time);
      const lastOut = new Date(clockedOutTime);
      const lastHours = Math.round(Math.max(0, (lastOut - lastIn) / (1000 * 60 * 60)) * 100) / 100;
      await pool.query(`UPDATE time_entries SET hours_worked = $1 WHERE id = $2`, [
        lastHours,
        entries[entries.length - 1].id,
      ]);
      console.log(
        `[updateShift] Synced bookend clock times to ${entries.length} time_entries for payroll`
      );
    } else if (entries.length === 0) {
      // No time_entries exist – create one so approve/dashboard counts it. If shift already approved, set approved_at now.
      const d =
        updatedShift.shift_date instanceof Date
          ? updatedShift.shift_date
          : new Date(updatedShift.shift_date);
      const shiftDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const hoursDiff = (new Date(clockedOutTime) - new Date(clockedInTime)) / (1000 * 60 * 60);
      const hoursWorked = Math.round(Math.max(0, hoursDiff) * 100) / 100;
      const isAlreadyApproved = updatedShift.status === 'approved';
      await pool.query(
        `INSERT INTO time_entries (staff_id, user_id, date, clock_in_time, clock_out_time, hours_worked, overtime_hours, entry_type, shift_id${isAlreadyApproved ? ', approved_at, approved_by' : ''})
         VALUES ($1, $2, $3, $4, $5, $6, 0, 'clock_in_out', $7${isAlreadyApproved ? ', NOW(), $8' : ''})`,
        isAlreadyApproved
          ? [
              updatedShift.staff_id,
              userId,
              shiftDate,
              clockedInTime,
              clockedOutTime,
              hoursWorked,
              shiftId,
              userId,
            ]
          : [
              updatedShift.staff_id,
              userId,
              shiftDate,
              clockedInTime,
              clockedOutTime,
              hoursWorked,
              shiftId,
            ]
      );
      console.log(
        `[updateShift] Created time_entry for actual hours (clock_in_out)${isAlreadyApproved ? ' – already approved, set approved_at' : ''}`
      );
    }
  }

  console.log(
    `[updateShift] Shift ${shiftId} updated successfully. clocked_in_time: ${updatedShift.clocked_in_time}, clocked_out_time: ${updatedShift.clocked_out_time}, pay_type: ${updatedShift.pay_type}, shift_type: ${updatedShift.shift_type}`
  );

  return updatedShift;
}

export async function deleteShift(shiftId, userId) {
  console.log(`[Delete Shift] Deleting shift ${shiftId} for user ${userId}`);

  const teResult = await pool.query('DELETE FROM time_entries WHERE shift_id = $1 RETURNING id', [
    shiftId,
  ]);
  if (teResult.rowCount > 0) {
    console.log(
      `[Delete Shift] Deleted ${teResult.rowCount} time entry/entries linked to shift ${shiftId}`
    );
  }

  const result = await pool.query(
    'DELETE FROM shifts WHERE id = $1 AND user_id = $2 RETURNING id',
    [shiftId, userId]
  );

  if (result.rowCount === 0) {
    console.log(`[Delete Shift] No shift found with id ${shiftId} for user ${userId}`);
    throw new Error('Shift not found or you do not have permission to delete it');
  }

  console.log(
    `[Delete Shift] Successfully deleted shift ${shiftId} (${result.rowCount} row(s) deleted)`
  );
  return result.rows[0];
}

export async function createBulkShifts(userId, shifts, options = {}) {
  const { createdByUserId = null, createdByStaffId = null } = options;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const createdShifts = [];

    for (const shift of shifts) {
      const staffIdNum = coercePositiveIntId(shift.staffId);
      if (staffIdNum === null) {
        throw new Error(INVALID_STAFF_ID);
      }
      // Verify that the staff member belongs to this user
      const staffCheck = await client.query('SELECT id FROM staff WHERE id = $1 AND user_id = $2', [
        staffIdNum,
        userId,
      ]);

      if (staffCheck.rows.length === 0) {
        throw new Error(`Staff member ${staffIdNum} not found or does not belong to this user`);
      }

      const shiftHours = parseFloat(shift.hours) || 0;

      // Sanitize string fields to remove null bytes
      const sanitizedLocation = shift.location ? sanitizeString(shift.location) : shift.location;
      const sanitizedNotes = shift.notes ? sanitizeString(shift.notes) : shift.notes;

      const result = await client.query(
        `INSERT INTO shifts (
          user_id, staff_id, shift_date, start_time, 
          hours, break_minutes, shift_type, pay_type, location, notes,
          created_by_user_id, created_by_staff_id
        ) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
        RETURNING *`,
        [
          userId,
          staffIdNum,
          shift.shiftDate,
          shift.startTime,
          shiftHours,
          shift.breakMinutes || 0,
          shift.shiftType || 'regular',
          shift.payType || 'regular',
          sanitizedLocation,
          sanitizedNotes,
          createdByUserId,
          createdByStaffId,
        ]
      );

      createdShifts.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return createdShifts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getShiftStats(userId, filters = {}) {
  let query = `
    SELECT 
      COUNT(*) as total_shifts,
      COUNT(DISTINCT staff_id) as staff_count,
      SUM(hours) as total_hours,
      COUNT(*) FILTER (WHERE status = 'scheduled') as scheduled_count,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
      COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_count
    FROM shifts
    WHERE user_id = $1
  `;

  const params = [userId];
  let paramCount = 1;

  if (filters.startDate) {
    paramCount++;
    query += ` AND shift_date >= $${paramCount}`;
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    paramCount++;
    query += ` AND shift_date <= $${paramCount}`;
    params.push(filters.endDate);
  }

  const result = await pool.query(query, params);
  return result.rows[0];
}

export async function checkShiftConflict(
  userId,
  staffId,
  shiftDate,
  startTime,
  endTime,
  excludeShiftId = null
) {
  const staffIdNum = coercePositiveIntId(staffId);
  if (staffIdNum === null) {
    throw new Error(INVALID_STAFF_ID);
  }

  const isOvernight = endTime < startTime;

  let query = `
    SELECT 
      id, 
      shift_date::text as shift_date, 
      start_time, 
      hours,
      status 
    FROM shifts
    WHERE user_id = $1 
    AND staff_id = $2 
    AND status != 'cancelled'
    AND (
      shift_date = $3
      OR ($4 = true AND shift_date = (DATE($3) + INTERVAL '1 day')::date)
      OR shift_date = (DATE($3) - INTERVAL '1 day')::date
    )
  `;

  const params = [userId, staffIdNum, shiftDate, isOvernight];

  if (excludeShiftId) {
    query += ' AND id != $5';
    params.push(excludeShiftId);
  }

  const result = await pool.query(query, params);

  const conflictingShifts = [];

  for (const existingShift of result.rows) {
    const existingEndTime = calculateEndTime(
      existingShift.start_time,
      parseFloat(existingShift.hours)
    );
    const existingIsOvernight = existingEndTime < existingShift.start_time;
    const existingShiftDate = existingShift.shift_date.split('T')[0];

    let checkConflict = false;

    if (existingShiftDate === shiftDate) {
      checkConflict = true;
    } else if (isOvernight) {
      const nextDay = new Date(shiftDate + 'T00:00:00');
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = formatLocalDate(nextDay);
      if (existingShiftDate === nextDayStr) {
        checkConflict = true;
      }
    } else if (existingIsOvernight) {
      const prevDay = new Date(shiftDate + 'T00:00:00');
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = formatLocalDate(prevDay);
      if (existingShiftDate === prevDayStr) {
        checkConflict = true;
      }
    }

    if (!checkConflict) {
      continue;
    }

    // Convert times to minutes for easier comparison
    const timeToMinutes = (timeStr) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };

    const newStart = timeToMinutes(startTime);
    const newEnd = timeToMinutes(endTime);
    const existingStart = timeToMinutes(existingShift.start_time);
    const existingEnd = timeToMinutes(existingEndTime);

    let overlaps = false;

    if (existingShiftDate === shiftDate) {
      // Same date
      if (!existingIsOvernight && !isOvernight) {
        // Both regular shifts - standard overlap: new starts before existing ends AND new ends after existing starts
        overlaps = newStart < existingEnd && newEnd > existingStart;
      } else if (existingIsOvernight && !isOvernight) {
        // Existing is overnight (22:20-08:20), new is regular (03:00-11:30)
        // Overnight shift spans: 22:20 (day 1) to 08:20 (day 2)
        // New shift: 03:00-11:30 (day 2)
        // They overlap if new shift starts before existing ends (03:00 < 08:20) AND new shift starts after existing started on day 1
        // But wait - existing started at 22:20 on day 1, new starts at 03:00 on day 2, so they overlap if 03:00 < 08:20
        overlaps = newStart < existingEnd;
      } else if (!existingIsOvernight && isOvernight) {
        // Existing is regular (00:00-08:00), new is overnight (17:00-01:00)
        // On same day, new overnight runs 17:00 to 24:00 (not 01:00 - that's next day)
        // Overlap if new starts before existing ends: e.g. 17:00 < 08:00? No.
        const newEndOnSameDay = 24 * 60; // midnight
        overlaps = newStart < existingEnd && newEndOnSameDay > existingStart;
      } else {
        // Both overnight - they overlap
        overlaps = true;
      }
    } else if (isOvernight && existingShiftDate !== shiftDate) {
      // New shift is overnight, existing is on next day
      // New: 22:20 (day 1) - 08:20 (day 2), Existing: on day 2
      // They overlap if existing starts before new ends on day 2
      overlaps = existingStart < newEnd;
    } else if (existingIsOvernight && existingShiftDate !== shiftDate) {
      // Existing is overnight, new is on day 2
      // Existing: 22:20 (day 1) - 08:20 (day 2), New: on day 2
      // They overlap if new starts before existing ends on day 2
      overlaps = newStart < existingEnd;
    }

    if (overlaps) {
      conflictingShifts.push({
        id: existingShift.id,
        date: existingShiftDate,
        start: existingShift.start_time,
        end: existingEndTime,
        status: existingShift.status,
      });
    }
  }

  return {
    hasConflict: conflictingShifts.length > 0,
    conflictingShifts,
  };
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Approve shift and convert to logged hours
export async function approveShift(shiftId, userId, approvedBy) {
  console.log(`[Approve] APPROVE FUNCTION CALLED for shift ${shiftId}`);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get shift details
    const shiftResult = await client.query(
      `SELECT s.*, st.name as staff_name, st.hourly_rate
       FROM shifts s
       JOIN staff st ON s.staff_id = st.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [shiftId, userId]
    );

    if (shiftResult.rows.length === 0) {
      throw new Error('Shift not found');
    }

    const shift = shiftResult.rows[0];
    const scheduledHours = parseFloat(shift.hours) || 0;
    console.log(
      `[Approve] Shift found: id=${shift.id}, staff_id=${shift.staff_id}, status=${shift.status}, scheduled hours=${scheduledHours}`
    );
    // #region agent log
    try {
      fs.appendFileSync(
        '/root/.cursor/debug-9a8e14.log',
        JSON.stringify({
          location: 'shifts.js:approveShift',
          message: 'Approve entry',
          data: {
            shiftId,
            shift_date: shift.shift_date?.toString?.(),
            clocked_in: !!shift.clocked_in_time,
            clocked_out: !!shift.clocked_out_time,
            clock_source: shift.clock_source,
          },
          timestamp: Date.now(),
          hypothesisId: 'H1',
        }) + '\n'
      );
    } catch (_) {}
    // #endregion

    if (shift.status === 'approved') {
      throw new Error('Shift has already been approved');
    }

    let regularHours;
    let overtimeHours;
    let timeEntryId = null;
    let actualHoursWorked = null;

    const isLeaveShift = shift.shift_type === 'paid_leave' || shift.shift_type === 'unpaid_leave';

    if (isLeaveShift) {
      const leaveCat = shift.shift_type === 'paid_leave' ? 'paid_leave' : 'unpaid_leave';
      const dateStr =
        shift.shift_date instanceof Date
          ? shift.shift_date.toISOString().split('T')[0]
          : String(shift.shift_date).split('T')[0];
      const scheduledLeaveHrs = Math.min(24, Math.max(0, parseFloat(shift.hours) || 0));

      await client.query(`DELETE FROM time_entries WHERE shift_id = $1`, [shiftId]);

      const ins = await client.query(
        `INSERT INTO time_entries (staff_id, user_id, date, hours_worked, overtime_hours, notes, entry_type, shift_id, leave_category)
         VALUES ($1, $2, $3::date, $4, 0, $5, 'approved_shift', $6, $7)
         RETURNING id`,
        [
          shift.staff_id,
          userId,
          dateStr,
          scheduledLeaveHrs,
          shift.notes ? `Leave (schedule): ${shift.notes}` : 'Leave (schedule)',
          shiftId,
          leaveCat,
        ]
      );
      const newTeId = ins.rows[0].id;

      await client.query(
        `UPDATE shifts 
         SET status = 'approved', 
             approved_at = NOW(), 
             approved_by = $1,
             time_entry_id = $2
         WHERE id = $3`,
        [approvedBy, newTeId, shiftId]
      );

      await client.query('COMMIT');
      return {
        success: true,
        timeEntryId: newTeId,
        regularHours: scheduledLeaveHrs,
        overtimeHours: 0,
        scheduledHours: scheduledLeaveHrs,
        actualHoursWorked: scheduledLeaveHrs,
        shift: { ...shift, status: 'approved', time_entry_id: newTeId },
      };
    }

    const teResult = await client.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0), 0)::numeric(10,2) as total
       FROM time_entries WHERE shift_id = $1 AND clock_in_time IS NOT NULL AND clock_out_time IS NOT NULL`,
      [shiftId]
    );
    const fromTimeEntries = parseFloat(teResult.rows[0]?.total || 0);
    // #region agent log
    try {
      fs.appendFileSync(
        '/root/.cursor/debug-9a8e14.log',
        JSON.stringify({
          location: 'shifts.js:approveShift',
          message: 'Actual hours source',
          data: {
            fromTimeEntries,
            hasShiftClockedIn: !!shift.clocked_in_time,
            hasShiftClockedOut: !!shift.clocked_out_time,
          },
          timestamp: Date.now(),
          hypothesisId: 'H2',
        }) + '\n'
      );
    } catch (_) {}
    // #endregion
    if (fromTimeEntries > 0) {
      actualHoursWorked = Math.round(fromTimeEntries * 100) / 100;
    } else if (shift.clocked_in_time && shift.clocked_out_time) {
      const clockInTime = new Date(shift.clocked_in_time);
      const clockOutTime = new Date(shift.clocked_out_time);
      const diffMs = clockOutTime - clockInTime;
      actualHoursWorked = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
    }

    if (actualHoursWorked != null && actualHoursWorked > 0) {
      if (actualHoursWorked > scheduledHours) {
        regularHours = scheduledHours;
        overtimeHours = Math.round((actualHoursWorked - scheduledHours) * 100) / 100;
      } else {
        regularHours = actualHoursWorked;
        overtimeHours = 0;
      }
      console.log(
        `[Approve] Actual hours worked: ${actualHoursWorked}h (scheduled: ${scheduledHours}h) → regular: ${regularHours}h, OT: ${overtimeHours}h`
      );
      if (fromTimeEntries > 0) {
        // #region agent log
        try {
          fs.appendFileSync(
            '/root/.cursor/debug-9a8e14.log',
            JSON.stringify({
              location: 'shifts.js:approveShift',
              message: 'Branch from time_entries',
              data: { fromTimeEntries, branch: 'update_approved_at' },
              timestamp: Date.now(),
              hypothesisId: 'H1',
            }) + '\n'
          );
        } catch (_) {}
        // #endregion
        // Approve all clock_in_out time entries for this shift (per-entry approval)
        const approveResult = await client.query(
          `UPDATE time_entries SET approved_at = NOW(), approved_by = $1
           WHERE shift_id = $2 AND entry_type = 'clock_in_out'
             AND clock_in_time IS NOT NULL AND clock_out_time IS NOT NULL
           RETURNING id`,
          [approvedBy, shiftId]
        );
        if (approveResult.rows.length > 0) {
          timeEntryId = approveResult.rows[0].id;
        }
      } else if (fromTimeEntries <= 0 && shift.clocked_in_time && shift.clocked_out_time) {
        const existing = await client.query(
          `SELECT id FROM time_entries WHERE shift_id = $1 ORDER BY id DESC LIMIT 1`,
          [shiftId]
        );
        const clockSource = shift.clock_source || null;
        // #region agent log
        try {
          fs.appendFileSync(
            '/root/.cursor/debug-9a8e14.log',
            JSON.stringify({
              location: 'shifts.js:approveShift',
              message: 'Branch shift has clock times',
              data: {
                existingCount: existing.rows.length,
                clockSource,
                branch:
                  existing.rows.length > 0 && clockSource !== 'manager'
                    ? 'update'
                    : clockSource === 'staff'
                      ? 'insert_clock_in_out'
                      : 'insert_approved_shift',
              },
              timestamp: Date.now(),
              hypothesisId: 'H5',
            }) + '\n'
          );
        } catch (_) {}
        // #endregion
        if (existing.rows.length > 0 && clockSource !== 'manager') {
          await client.query(
            `UPDATE time_entries SET clock_in_time = $1, clock_out_time = $2, hours_worked = $3, overtime_hours = $4, entry_type = 'clock_in_out'
             WHERE id = $5`,
            [
              shift.clocked_in_time,
              shift.clocked_out_time,
              regularHours,
              overtimeHours,
              existing.rows[0].id,
            ]
          );
          timeEntryId = existing.rows[0].id;
        } else if (clockSource === 'staff') {
          // Edge case: staff clocked in but time_entry was lost - create with clock times
          const timeEntryResult = await client.query(
            `INSERT INTO time_entries 
             (staff_id, user_id, date, clock_in_time, clock_out_time, hours_worked, overtime_hours, notes, entry_type, shift_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              shift.staff_id,
              userId,
              shift.shift_date,
              shift.clocked_in_time,
              shift.clocked_out_time,
              regularHours,
              overtimeHours,
              shift.notes
                ? `Approved from shift: ${shift.notes}`
                : 'Approved from actual clock times',
              'clock_in_out',
              shiftId,
            ]
          );
          timeEntryId = timeEntryResult.rows[0].id;
        } else {
          // Manager set times (clock_source=manager or null) - create approved_shift with hours ONLY, no clock times
          const timeEntryResult = await client.query(
            `INSERT INTO time_entries 
             (staff_id, user_id, date, hours_worked, overtime_hours, notes, entry_type, shift_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              shift.staff_id,
              userId,
              shift.shift_date,
              regularHours,
              overtimeHours,
              shift.notes ? `Approved from shift: ${shift.notes}` : 'Approved (manager-set times)',
              'approved_shift',
              shiftId,
            ]
          );
          timeEntryId = timeEntryResult.rows[0].id;
        }
      }
    } else {
      // No actual clock data: approve shift status only – do NOT add scheduled hours to dashboard.
      // Dashboard only counts actual hours; scheduled hours without clock times must not count.
      regularHours = 0;
      overtimeHours = 0;
      console.log(`[Approve] No clock data – approving status only, no hours added to dashboard`);
    }

    await client.query(
      `UPDATE shifts 
       SET status = 'approved', 
           approved_at = NOW(), 
           approved_by = $1,
           time_entry_id = COALESCE($2, time_entry_id)
       WHERE id = $3`,
      [approvedBy, timeEntryId, shiftId]
    );

    await client.query('COMMIT');
    // #region agent log
    try {
      fs.appendFileSync(
        '/root/.cursor/debug-9a8e14.log',
        JSON.stringify({
          location: 'shifts.js:approveShift',
          message: 'Approve result',
          data: { timeEntryId, regularHours, overtimeHours, actualHoursWorked },
          timestamp: Date.now(),
          hypothesisId: 'H3',
        }) + '\n'
      );
    } catch (_) {}
    // #endregion
    return {
      success: true,
      timeEntryId,
      regularHours,
      overtimeHours,
      scheduledHours,
      actualHoursWorked: actualHoursWorked ?? undefined,
      shift,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Approve multiple shifts at once
export async function approveShifts(shiftIds, userId, approvedBy) {
  const results = [];
  const errors = [];

  for (const shiftId of shiftIds) {
    try {
      const result = await approveShift(shiftId, userId, approvedBy);
      results.push({ shiftId, ...result });
    } catch (error) {
      errors.push({ shiftId, error: error.message });
    }
  }

  return { results, errors };
}

// Unapprove shift (reverse approval, delete time entry)
export async function unapproveShift(shiftId, userId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get shift details
    const shiftResult = await client.query(`SELECT * FROM shifts WHERE id = $1 AND user_id = $2`, [
      shiftId,
      userId,
    ]);

    if (shiftResult.rows.length === 0) {
      throw new Error('Shift not found');
    }

    const shift = shiftResult.rows[0];

    // Check if shift is approved - allow unapproving even if time_entry_id is null
    // (clock-out approved shifts may not have time_entry_id set)
    if (shift.status !== 'approved') {
      throw new Error('Shift is not approved');
    }

    // Check if the time entry is from clock-in/out (actual tracked hours) or manual approval
    const timeEntryResult = await client.query(
      `SELECT entry_type, clock_in_time FROM time_entries WHERE id = $1`,
      [shift.time_entry_id]
    );

    if (timeEntryResult.rows.length > 0) {
      const timeEntry = timeEntryResult.rows[0];

      // Only delete time entries that were manually created (approved_shift type)
      // Keep time entries with actual clock-in/out data (clock_in_out type) as they represent real worked hours
      if (timeEntry.entry_type === 'approved_shift' || !timeEntry.clock_in_time) {
        // Delete the manually created time entry
        await client.query('DELETE FROM time_entries WHERE id = $1', [shift.time_entry_id]);
      } else {
        // For clock_in_out entries, clear approved_at so they no longer count for payroll
        await client.query(
          `UPDATE time_entries SET approved_at = NULL, approved_by = NULL
           WHERE shift_id = $1 AND entry_type = 'clock_in_out'`,
          [shiftId]
        );
        console.log(`[Unapprove] Cleared approved_at on clock_in_out entries for shift ${shiftId}`);
      }
    }

    // Check if shift is currently clocked in (has clocked_in_time but no clocked_out_time)
    // If so, we need to clock them out by clearing clocked_in_time and closing any active time entries
    if (shift.clocked_in_time && !shift.clocked_out_time) {
      console.log(
        `[Unapprove] Shift ${shiftId} is currently clocked in - clocking out before unapproving`
      );

      // Clear clocked_in_time (this effectively clocks them out)
      await client.query(`UPDATE shifts SET clocked_in_time = NULL WHERE id = $1`, [shiftId]);

      // Close any active time entries (set clock_out_time to clock_in_time if not already set)
      const activeTimeEntries = await client.query(
        `SELECT id, clock_in_time FROM time_entries 
         WHERE shift_id = $1 AND clock_out_time IS NULL`,
        [shiftId]
      );

      for (const entry of activeTimeEntries.rows) {
        await client.query(
          `UPDATE time_entries 
           SET clock_out_time = clock_in_time 
           WHERE id = $1`,
          [entry.id]
        );
        console.log(`[Unapprove] Closed time entry ${entry.id} for shift ${shiftId}`);
      }
    }
    // Decide what status to revert to after unapproving.
    // If there is a late clock-out reason recorded on any time entry for this shift,
    // restore the special 'review_hours' state so the manager can see and review it again.
    // Otherwise, if the shift has already ended and there are no actual completed hours,
    // mark it as 'unattended'. If the shift is in the future or still in progress,
    // fall back to 'scheduled'.
    const lateReasonResult = await client.query(
      `SELECT 1 FROM time_entries 
       WHERE shift_id = $1 
         AND notes IS NOT NULL 
         AND notes LIKE 'Late clock-out reason:%'
       LIMIT 1`,
      [shiftId]
    );

    let newStatus;
    if (lateReasonResult.rows.length > 0) {
      newStatus = 'review_hours';
    } else {
      // No late-reason flag; decide between 'unattended' vs 'scheduled'
      const now = new Date();
      const shiftDateStr =
        shift.shift_date instanceof Date
          ? shift.shift_date.toISOString().split('T')[0]
          : typeof shift.shift_date === 'string'
            ? shift.shift_date.split('T')[0]
            : shift.shift_date;

      const shiftDate = new Date(shiftDateStr + 'T00:00:00');
      const calculatedEndTime = calculateEndTime(shift.start_time, shift.hours);
      const endTimeParts = calculatedEndTime.split(':').map(Number);

      const shiftEnd = new Date(
        shiftDate.getFullYear(),
        shiftDate.getMonth(),
        shiftDate.getDate(),
        endTimeParts[0] || 0,
        endTimeParts[1] || 0,
        endTimeParts[2] || 0
      );

      // Handle overnight shifts (end time earlier than start time → next day)
      if (calculatedEndTime < shift.start_time) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }

      const hasCompletedClockTimes = shift.clocked_in_time && shift.clocked_out_time;
      const shiftHasEnded = now.getTime() > shiftEnd.getTime();

      // If the shift has ended and there are no completed clock times,
      // treat it as unattended. Otherwise keep it scheduled.
      if (shiftHasEnded && !hasCompletedClockTimes) {
        newStatus = 'unattended';
      } else {
        newStatus = 'scheduled';
      }
    }

    await client.query(
      `UPDATE shifts 
       SET status = $1, 
           approved_at = NULL, 
           approved_by = NULL,
           time_entry_id = NULL
       WHERE id = $2`,
      [newStatus, shiftId]
    );

    await client.query('COMMIT');

    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
