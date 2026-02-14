import pool from './db.js';

export function calculateEndTime(startTime, hours) {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const totalMinutes = startHour * 60 + startMin + (hours * 60);
  const endMinutes = totalMinutes % (24 * 60);
  const endHour = Math.floor(endMinutes / 60);
  const endMin = endMinutes % 60;
  return `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00`;
}

export async function getShifts(userId, filters = {}) {
  let query = `
    SELECT 
      s.id,
      s.user_id,
      s.staff_id,
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
      s.time_entry_id,
      s.clocked_in_time,
      s.clocked_out_time,
      s.clock_source,
      (COALESCE(
        NULLIF((SELECT SUM(EXTRACT(EPOCH FROM (te.clock_out_time - te.clock_in_time)) / 3600.0) FROM time_entries te WHERE te.shift_id = s.id AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL), 0),
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
  
  query += ' ORDER BY s.shift_date, s.start_time';
  
  const result = await pool.query(query, params);
  
  const now = new Date();
  const updatePromises = [];
  
  console.log(`[getShifts] Processing ${result.rows.length} shifts for auto-completion check`);
  
  for (const row of result.rows) {
    if (row.status === 'approved' || row.status === 'completed' || row.approved_at) {
      continue;
    }
    
    if (row.clocked_in_time && !row.clocked_out_time) {
      console.log(`[getShifts] Skipping auto-update for shift ${row.id} - currently clocked in (overnight shift in progress)`);
      continue;
    }
    
    try {
      const shiftDateStr = row.shift_date instanceof Date ? row.shift_date.toISOString().split('T')[0] : (typeof row.shift_date === 'string' ? row.shift_date.split('T')[0] : row.shift_date);
      const shiftDate = new Date(shiftDateStr + 'T00:00:00');
      const startTime = row.start_time.split(':').map(Number);
      
      const calculatedEndTime = calculateEndTime(row.start_time, row.hours);
      const endTime = calculatedEndTime.split(':').map(Number);
      
      const shiftStart = new Date(Date.UTC(
        shiftDate.getFullYear(),
        shiftDate.getMonth(),
        shiftDate.getDate(),
        startTime[0],
        startTime[1],
        startTime[2] || 0
      ));
      
      const shiftEnd = new Date(Date.UTC(
        shiftDate.getFullYear(),
        shiftDate.getMonth(),
        shiftDate.getDate(),
        endTime[0],
        endTime[1],
        endTime[2] || 0
      ));
      
      // Handle overnight shifts (if calculated end_time < start_time, it goes to next day)
      if (calculatedEndTime < row.start_time) {
        shiftEnd.setUTCDate(shiftEnd.getUTCDate() + 1);
      }
      
      // Check current time vs shift times
      const nowTimestamp = now.getTime();
      const shiftStartTimestamp = shiftStart.getTime();
      const shiftEndTimestamp = shiftEnd.getTime();
      const hasClockIn = row.clocked_in_time && row.clocked_in_time !== null;
      
      // Check if shift has ended
      // IMPORTANT: Only mark as completed/unattended if the shift has actually ended AND they're not currently clocked in
      // The check above already skips shifts that are clocked in, but we add an extra safety check here
      if (nowTimestamp > shiftEndTimestamp && !row.clocked_in_time) {
        // Determine status:
        // - If the shift has a full pair of clock-in and clock-out times, mark as 'completed'
        // - Otherwise (no actual completed hours), mark as 'unattended'
        const hasClockOut = row.clocked_out_time && row.clocked_out_time !== null;
        const hasCompletedHours = hasClockIn && hasClockOut;
        const newStatus = hasCompletedHours ? 'completed' : 'unattended';
        
        console.log(`[getShifts] Auto-marking shift ${row.id} as ${newStatus} (ended at ${shiftEnd.toISOString()}, now is ${now.toISOString()}, clocked in: ${hasClockIn}, clocked out: ${hasClockOut})`);
        // Update shift status in database
        updatePromises.push(
          pool.query(
            `UPDATE shifts SET status = $1, updated_at = NOW() WHERE id = $2 AND status IN ('scheduled', 'late')`,
            [newStatus, row.id]
          ).then(result => {
            if (result.rowCount > 0) {
              console.log(`[getShifts] Successfully marked shift ${row.id} as ${newStatus}`);
            } else {
              console.log(`[getShifts] Shift ${row.id} was not updated (may have been updated concurrently)`);
            }
          }).catch(err => {
            console.error(`[getShifts] Error updating shift ${row.id}:`, err);
          })
        );
        // Update the row object immediately for this response
        row.status = newStatus;
      } else if (nowTimestamp > shiftStartTimestamp && nowTimestamp < shiftEndTimestamp && !hasClockIn) {
        // Shift has started but not ended, and staff hasn't clocked in yet - mark as 'late'
        // Only mark as late if shift is in progress (between start and end time)
        console.log(`[getShifts] Auto-marking shift ${row.id} as late (started at ${shiftStart.toISOString()}, now is ${now.toISOString()}, no clock-in)`);
        updatePromises.push(
          pool.query(
            `UPDATE shifts SET status = 'late', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`,
            [row.id]
          ).then(result => {
            if (result.rowCount > 0) {
              console.log(`[getShifts] Successfully marked shift ${row.id} as late`);
            } else {
              console.log(`[getShifts] Shift ${row.id} was not updated to late (may have been updated concurrently)`);
            }
          }).catch(err => {
            console.error(`[getShifts] Error updating shift ${row.id} to late:`, err);
          })
        );
        // Update the row object immediately for this response
        row.status = 'late';
      }
    } catch (err) {
      console.error(`[getShifts] Error processing shift ${row.id} for auto-completion:`, err);
    }
  }
  
  // Execute all updates in parallel and WAIT for them to complete before returning
  // This ensures the database is updated before the client receives the response
  if (updatePromises.length > 0) {
    console.log(`[getShifts] Executing ${updatePromises.length} status update(s) before returning data`);
    await Promise.all(updatePromises).catch(err => {
      console.error('[getShifts] Error auto-updating shift statuses:', err);
    });
    console.log(`[getShifts] All status updates completed`);
  }
  
  // After updates complete, fetch the updated statuses from the database to ensure accuracy
  // This guarantees the client receives the latest status
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
      
      // Update the result rows with the actual database status
      const statusMap = {};
      statusResult.rows.forEach(s => {
        statusMap[s.id] = s.status;
      });
      
      result.rows.forEach(row => {
        if (statusMap[row.id]) {
          row.status = statusMap[row.id];
        }
      });
    }
  }
  
  // Explicitly ensure NULL values are returned as null (not empty strings or undefined)
  // Also calculate end_time for each shift and normalize shift_date
  return result.rows.map(shift => {
    const cleaned = { ...shift };
    // Force NULL values to be null (not undefined or empty string)
    cleaned.clocked_in_time = (shift.clocked_in_time === null || shift.clocked_in_time === undefined || shift.clocked_in_time === '') ? null : shift.clocked_in_time;
    cleaned.clocked_out_time = (shift.clocked_out_time === null || shift.clocked_out_time === undefined || shift.clocked_out_time === '') ? null : shift.clocked_out_time;
    cleaned.actual_hours_worked = shift.actual_hours_worked != null ? parseFloat(shift.actual_hours_worked) : 0;
    // Normalize shift_date to YYYY-MM-DD format (PostgreSQL DATE returns as Date object or string)
    if (shift.shift_date instanceof Date) {
      // Convert Date object to YYYY-MM-DD string using local timezone
      const year = shift.shift_date.getFullYear();
      const month = String(shift.shift_date.getMonth() + 1).padStart(2, '0');
      const day = String(shift.shift_date.getDate()).padStart(2, '0');
      cleaned.shift_date = `${year}-${month}-${day}`;
    } else if (typeof shift.shift_date === 'string') {
      // Extract just the date part (YYYY-MM-DD) if it includes time
      cleaned.shift_date = shift.shift_date.split('T')[0];
    }
    // Calculate end_time from start_time + hours for frontend compatibility
    cleaned.end_time = calculateEndTime(shift.start_time, shift.hours);
    return cleaned;
  });
}

// Get single shift
export async function getShiftById(shiftId, userId) {
  const result = await pool.query(
    `SELECT s.*, s.shift_date::text as shift_date, st.name as staff_name, st.role, st.hourly_rate
     FROM shifts s
     JOIN staff st ON s.staff_id = st.id
     WHERE s.id = $1 AND s.user_id = $2`,
    [shiftId, userId]
  );
  
  if (result.rows[0]) {
    // Normalize shift_date to YYYY-MM-DD format
    const shift = result.rows[0];
    if (shift.shift_date) {
      shift.shift_date = shift.shift_date.split('T')[0];
    }
  }
  
  return result.rows[0];
}

// Create shift
export async function createShift(userId, data) {
  const {
    staffId,
    shiftDate,
    startTime,
    hours,
    breakMinutes,
    shiftType,
    payType,
    location,
    notes
  } = data;
  
  // Ensure shiftDate is in YYYY-MM-DD format (no time component)
  const normalizedDate = shiftDate.split('T')[0];
  console.log('[createShift] Creating shift with date:', normalizedDate, 'original:', shiftDate);
  
  // Hours are now provided directly, no need to calculate from endTime
  const shiftHours = parseFloat(hours) || 0;
  
  // Calculate end_time for database storage (if end_time column still exists during migration)
  // Note: After migration, end_time column will be removed
  const calculatedEndTime = calculateEndTime(startTime, shiftHours);
  
  const result = await pool.query(
    `INSERT INTO shifts (
      user_id, staff_id, shift_date, start_time, hours, 
      break_minutes, shift_type, pay_type, location, notes
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
    RETURNING *`,
    [
      userId, 
      staffId, 
      normalizedDate, // Use normalized date
      startTime, 
      shiftHours,
      breakMinutes || 0,
      shiftType || 'regular',
      payType || 'regular',
      location,
      notes
    ]
  );
  
  console.log('[createShift] Shift created in DB. shift_date:', result.rows[0].shift_date);
  return result.rows[0];
}

// Update shift
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
    clockedOutTime
  } = data;
  
  // Hours are now provided directly, no need to calculate from endTime
  const shiftHours = hours !== undefined ? parseFloat(hours) : undefined;
  
  // Build dynamic UPDATE query based on which fields are provided
  const updates = [];
  const values = [];
  let paramCount = 1;
  
  if (staffId !== undefined) {
    updates.push(`staff_id = $${paramCount++}`);
    values.push(staffId);
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
    values.push(location);
  }
  if (notes !== undefined) {
    updates.push(`notes = $${paramCount++}`);
    values.push(notes);
  }
  if (clockedInTime !== undefined || clockedOutTime !== undefined) {
    updates.push(`clock_source = 'manager'`); // manager manually set times, not actual staff clock-in
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
  
  // Always update the updated_at timestamp
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
  
  console.log(`[updateShift] Shift ${shiftId} updated successfully. clocked_in_time: ${result.rows[0].clocked_in_time}, clocked_out_time: ${result.rows[0].clocked_out_time}, pay_type: ${result.rows[0].pay_type}, shift_type: ${result.rows[0].shift_type}`);
  
  return result.rows[0];
}

export async function deleteShift(shiftId, userId) {
  console.log(`[Delete Shift] Deleting shift ${shiftId} for user ${userId}`);
  
  // Delete associated time entries so hours from this shift are no longer counted in payroll
  const teResult = await pool.query(
    'DELETE FROM time_entries WHERE shift_id = $1 RETURNING id',
    [shiftId]
  );
  if (teResult.rowCount > 0) {
    console.log(`[Delete Shift] Deleted ${teResult.rowCount} time entry/entries linked to shift ${shiftId}`);
  }

  const result = await pool.query(
    'DELETE FROM shifts WHERE id = $1 AND user_id = $2 RETURNING id',
    [shiftId, userId]
  );
  
  if (result.rowCount === 0) {
    console.log(`[Delete Shift] No shift found with id ${shiftId} for user ${userId}`);
    throw new Error('Shift not found or you do not have permission to delete it');
  }
  
  console.log(`[Delete Shift] Successfully deleted shift ${shiftId} (${result.rowCount} row(s) deleted)`);
  return result.rows[0];
}

// Bulk create shifts (for recurring schedules)
export async function createBulkShifts(userId, shifts) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const createdShifts = [];
    
    for (const shift of shifts) {
      // Hours are now provided directly
      const shiftHours = parseFloat(shift.hours) || 0;
      
      const result = await client.query(
        `INSERT INTO shifts (
          user_id, staff_id, shift_date, start_time, 
          hours, break_minutes, shift_type, pay_type, location, notes
        ) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
        RETURNING *`,
        [
          userId,
          shift.staffId,
          shift.shiftDate,
          shift.startTime,
          shiftHours,
          shift.breakMinutes || 0,
          shift.shiftType || 'regular',
          shift.payType || 'regular',
          shift.location,
          shift.notes
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

// Get shift statistics
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

// Check for shift conflicts
// Returns { hasConflict: boolean, conflictingShifts: array }
export async function checkShiftConflict(userId, staffId, shiftDate, startTime, endTime, excludeShiftId = null) {
  // Handle overnight shifts: if endTime < startTime, the shift spans to next day
  const isOvernight = endTime < startTime;
  
  // Get all shifts for this staff member on the relevant dates
  // Calculate end_time from hours for existing shifts (since we're moving away from storing end_time)
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
  
  const params = [userId, staffId, shiftDate, isOvernight];
  
  if (excludeShiftId) {
    query += ' AND id != $5';
    params.push(excludeShiftId);
  }
  
  const result = await pool.query(query, params);
  
  // Calculate end_time for each existing shift and check for conflicts
  const conflictingShifts = [];
  
  for (const existingShift of result.rows) {
    // Calculate end_time from start_time + hours for existing shift
    const existingEndTime = calculateEndTime(existingShift.start_time, parseFloat(existingShift.hours));
    const existingIsOvernight = existingEndTime < existingShift.start_time;
    const existingShiftDate = existingShift.shift_date.split('T')[0];
    
    // Determine if dates could overlap (considering overnight shifts)
    let checkConflict = false;
    
    if (existingShiftDate === shiftDate) {
      // Same date - always check
      checkConflict = true;
    } else if (isOvernight) {
      // New shift is overnight - check if existing is on next day
      const nextDay = new Date(shiftDate + 'T00:00:00');
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = formatLocalDate(nextDay);
      if (existingShiftDate === nextDayStr) {
        checkConflict = true;
      }
    } else if (existingIsOvernight) {
      // Existing shift is overnight - check if it's on previous day
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
        overlaps = (newStart < existingEnd && newEnd > existingStart);
      } else if (existingIsOvernight && !isOvernight) {
        // Existing is overnight (22:20-08:20), new is regular (03:00-11:30)
        // Overnight shift spans: 22:20 (day 1) to 08:20 (day 2)
        // New shift: 03:00-11:30 (day 2)
        // They overlap if new shift starts before existing ends (03:00 < 08:20) AND new shift starts after existing started on day 1
        // But wait - existing started at 22:20 on day 1, new starts at 03:00 on day 2, so they overlap if 03:00 < 08:20
        overlaps = (newStart < existingEnd);
      } else if (!existingIsOvernight && isOvernight) {
        // Existing is regular, new is overnight
        overlaps = (existingStart < newEnd);
      } else {
        // Both overnight - they overlap
        overlaps = true;
      }
    } else if (isOvernight && existingShiftDate !== shiftDate) {
      // New shift is overnight, existing is on next day
      // New: 22:20 (day 1) - 08:20 (day 2), Existing: on day 2
      // They overlap if existing starts before new ends on day 2
      overlaps = (existingStart < newEnd);
    } else if (existingIsOvernight && existingShiftDate !== shiftDate) {
      // Existing is overnight, new is on day 2
      // Existing: 22:20 (day 1) - 08:20 (day 2), New: on day 2
      // They overlap if new starts before existing ends on day 2
      overlaps = (newStart < existingEnd);
    }
    
    if (overlaps) {
      conflictingShifts.push({
        id: existingShift.id,
        date: existingShiftDate,
        start: existingShift.start_time,
        end: existingEndTime,
        status: existingShift.status
      });
    }
  }
  
  return {
    hasConflict: conflictingShifts.length > 0,
    conflictingShifts
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
    console.log(`[Approve] Shift found: id=${shift.id}, staff_id=${shift.staff_id}, status=${shift.status}, scheduled hours=${scheduledHours}`);
    
    // Check if already approved
    if (shift.status === 'approved') {
      throw new Error('Shift has already been approved');
    }
    
    let regularHours;
    let overtimeHours;
    let timeEntryId = null;
    let actualHoursWorked = null;
    
    // Prefer actual hours from time_entries (clock_in/clock_out) for this shift, then shift.clocked_* times
    const teResult = await client.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 3600.0), 0)::numeric(10,2) as total
       FROM time_entries WHERE shift_id = $1 AND clock_in_time IS NOT NULL AND clock_out_time IS NOT NULL`,
      [shiftId]
    );
    const fromTimeEntries = parseFloat(teResult.rows[0]?.total || 0);
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
      console.log(`[Approve] Actual hours worked: ${actualHoursWorked}h (scheduled: ${scheduledHours}h) → regular: ${regularHours}h, OT: ${overtimeHours}h`);
      // If actual hours came from time_entries (staff actually clocked in), we're done - payroll uses those.
      // If from shift.clocked_* but no time_entry from staff: manager manually set times (clock_source=manager).
      // Create approved_shift with hours only, NO clock_in/clock_out - so "Hours This Week" and payroll
      // (which require clock times) won't count it. Only actual staff clock-in counts.
      if (fromTimeEntries <= 0 && shift.clocked_in_time && shift.clocked_out_time) {
        const existing = await client.query(
          `SELECT id FROM time_entries WHERE shift_id = $1 ORDER BY id DESC LIMIT 1`,
          [shiftId]
        );
        const clockSource = shift.clock_source || null;
        // Existing time_entry = staff clocked in (created by clock-in flow); update with clock times
        if (existing.rows.length > 0 && clockSource !== 'manager') {
          await client.query(
            `UPDATE time_entries SET clock_in_time = $1, clock_out_time = $2, hours_worked = $3, overtime_hours = $4, entry_type = 'clock_in_out'
             WHERE id = $5`,
            [shift.clocked_in_time, shift.clocked_out_time, regularHours, overtimeHours, existing.rows[0].id]
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
              shift.notes ? `Approved from shift: ${shift.notes}` : 'Approved from actual clock times',
              'clock_in_out',
              shiftId
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
              shiftId
            ]
          );
          timeEntryId = timeEntryResult.rows[0].id;
        }
      }
    } else {
      regularHours = scheduledHours;
      overtimeHours = 0;
      console.log(`[Approve] No clock data, using scheduled hours: ${regularHours}h`);
      
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
          shift.notes ? `Approved from shift: ${shift.notes}` : 'Approved from scheduled shift',
          'approved_shift',
          shiftId
        ]
      );
      timeEntryId = timeEntryResult.rows[0].id;
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
    
    return {
      success: true,
      timeEntryId,
      regularHours,
      overtimeHours,
      scheduledHours,
      actualHoursWorked: actualHoursWorked ?? undefined,
      shift
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
    const shiftResult = await client.query(
      `SELECT * FROM shifts WHERE id = $1 AND user_id = $2`,
      [shiftId, userId]
    );
    
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
        await client.query(
          'DELETE FROM time_entries WHERE id = $1',
          [shift.time_entry_id]
        );
      } else {
        // For clock-in/out entries, just unlink the shift but keep the time entry
        // This preserves the actual hours worked
        console.log(`[Unapprove] Keeping time entry ${shift.time_entry_id} as it contains actual clock-in/out data`);
      }
    }
    
    // Check if shift is currently clocked in (has clocked_in_time but no clocked_out_time)
    // If so, we need to clock them out by clearing clocked_in_time and closing any active time entries
    if (shift.clocked_in_time && !shift.clocked_out_time) {
      console.log(`[Unapprove] Shift ${shiftId} is currently clocked in - clocking out before unapproving`);
      
      // Clear clocked_in_time (this effectively clocks them out)
      await client.query(
        `UPDATE shifts SET clocked_in_time = NULL WHERE id = $1`,
        [shiftId]
      );
      
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
      const shiftDateStr = shift.shift_date instanceof Date
        ? shift.shift_date.toISOString().split('T')[0]
        : (typeof shift.shift_date === 'string' ? shift.shift_date.split('T')[0] : shift.shift_date);
      
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
