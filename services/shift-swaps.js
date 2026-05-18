import { pool } from '../lib/db.js';
import { calculateEndTime } from './shifts.js';

export async function createSwapRequest(
  requesterStaffId,
  requesterShiftId,
  requestedShiftId,
  message = null
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const requesterShiftResult = await client.query(
      'SELECT id, staff_id, user_id, shift_date, status FROM shifts WHERE id = $1',
      [requesterShiftId]
    );

    if (requesterShiftResult.rows.length === 0) {
      throw new Error('Requester shift not found');
    }

    const requesterShift = requesterShiftResult.rows[0];
    if (requesterShift.staff_id !== requesterStaffId) {
      throw new Error('You do not own the requester shift');
    }

    if (requesterShift.status === 'cancelled') {
      throw new Error('Cannot swap a cancelled shift');
    }

    const requestedShiftResult = await client.query(
      'SELECT id, staff_id, user_id, shift_date, status FROM shifts WHERE id = $1',
      [requestedShiftId]
    );

    if (requestedShiftResult.rows.length === 0) {
      throw new Error('Requested shift not found');
    }

    const requestedShift = requestedShiftResult.rows[0];
    const requestedStaffId = requestedShift.staff_id;

    if (requesterShift.user_id !== requestedShift.user_id) {
      throw new Error('Shifts must belong to the same company');
    }

    if (requesterStaffId === requestedStaffId) {
      throw new Error('Cannot swap shift with yourself');
    }

    if (requestedShift.status === 'cancelled') {
      throw new Error('Cannot swap with a cancelled shift');
    }

    const existingRequest = await client.query(
      `SELECT id FROM shift_swap_requests 
       WHERE ((requester_shift_id = $1 AND requested_shift_id = $2) 
          OR (requester_shift_id = $2 AND requested_shift_id = $1))
       AND status = 'pending'`,
      [requesterShiftId, requestedShiftId]
    );

    if (existingRequest.rows.length > 0) {
      throw new Error('A pending swap request already exists for these shifts');
    }

    const result = await client.query(
      `INSERT INTO shift_swap_requests 
       (requester_shift_id, requested_shift_id, requester_staff_id, requested_staff_id, message, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [requesterShiftId, requestedShiftId, requesterStaffId, requestedStaffId, message]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getSwapRequestsForStaff(staffId, filters = {}) {
  let query = `
    SELECT 
      ssr.*,
      rs.id as requester_shift_id,
      rs.shift_date as requester_shift_date,
      rs.start_time as requester_start_time,
      rs.hours as requester_hours,
      rs.location as requester_location,
      rs.notes as requester_notes,
      rqs.id as requested_shift_id,
      rqs.shift_date as requested_shift_date,
      rqs.start_time as requested_start_time,
      rqs.hours as requested_hours,
      rqs.location as requested_location,
      rqs.notes as requested_notes,
      requester_staff.name as requester_staff_name,
      requested_staff.name as requested_staff_name
    FROM shift_swap_requests ssr
    JOIN shifts rs ON ssr.requester_shift_id = rs.id
    JOIN shifts rqs ON ssr.requested_shift_id = rqs.id
    JOIN staff requester_staff ON ssr.requester_staff_id = requester_staff.id
    JOIN staff requested_staff ON ssr.requested_staff_id = requested_staff.id
    WHERE (ssr.requester_staff_id = $1 OR ssr.requested_staff_id = $1)
  `;

  const params = [staffId];
  let paramCount = 1;

  if (filters.status) {
    paramCount++;
    query += ` AND ssr.status = $${paramCount}`;
    params.push(filters.status);
  }

  query += ' ORDER BY ssr.created_at DESC';

  const result = await pool.query(query, params);

  return result.rows.map((row) => {
    if (row.requester_start_time && row.requester_hours) {
      row.requester_end_time = calculateEndTime(
        row.requester_start_time,
        parseFloat(row.requester_hours)
      );
    }
    if (row.requested_start_time && row.requested_hours) {
      row.requested_end_time = calculateEndTime(
        row.requested_start_time,
        parseFloat(row.requested_hours)
      );
    }
    return row;
  });
}

export async function getSwapRequestsForCompany(userId, filters = {}) {
  let query = `
    SELECT 
      ssr.*,
      rs.id as requester_shift_id,
      rs.shift_date as requester_shift_date,
      rs.start_time as requester_start_time,
      rs.hours as requester_hours,
      rs.location as requester_location,
      rs.notes as requester_notes,
      rqs.id as requested_shift_id,
      rqs.shift_date as requested_shift_date,
      rqs.start_time as requested_start_time,
      rqs.hours as requested_hours,
      rqs.location as requested_location,
      rqs.notes as requested_notes,
      requester_staff.name as requester_staff_name,
      requested_staff.name as requested_staff_name
    FROM shift_swap_requests ssr
    JOIN shifts rs ON ssr.requester_shift_id = rs.id
    JOIN shifts rqs ON ssr.requested_shift_id = rqs.id
    JOIN staff requester_staff ON ssr.requester_staff_id = requester_staff.id
    JOIN staff requested_staff ON ssr.requested_staff_id = requested_staff.id
    WHERE rs.user_id = $1
  `;

  const params = [userId];
  let paramCount = 1;

  if (filters.status) {
    paramCount++;
    query += ` AND ssr.status = $${paramCount}`;
    params.push(filters.status);
  }

  query += ' ORDER BY ssr.created_at DESC';

  const result = await pool.query(query, params);

  return result.rows.map((row) => {
    if (row.requester_start_time && row.requester_hours) {
      row.requester_end_time = calculateEndTime(
        row.requester_start_time,
        parseFloat(row.requester_hours)
      );
    }
    if (row.requested_start_time && row.requested_hours) {
      row.requested_end_time = calculateEndTime(
        row.requested_start_time,
        parseFloat(row.requested_hours)
      );
    }
    return row;
  });
}

export async function acceptSwapRequest(swapRequestId, staffId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const swapRequestResult = await client.query(
      `SELECT ssr.*, rs.user_id, rs.staff_id as requester_shift_staff_id, 
              rqs.staff_id as requested_shift_staff_id
       FROM shift_swap_requests ssr
       JOIN shifts rs ON ssr.requester_shift_id = rs.id
       JOIN shifts rqs ON ssr.requested_shift_id = rqs.id
       WHERE ssr.id = $1`,
      [swapRequestId]
    );

    if (swapRequestResult.rows.length === 0) {
      throw new Error('Swap request not found');
    }

    const swapRequest = swapRequestResult.rows[0];

    if (swapRequest.requested_staff_id !== staffId) {
      throw new Error('You can only accept swap requests directed to you');
    }

    if (swapRequest.status !== 'pending') {
      throw new Error(`Cannot accept a swap request with status: ${swapRequest.status}`);
    }

    const requesterShiftCheck = await client.query('SELECT status FROM shifts WHERE id = $1', [
      swapRequest.requester_shift_id,
    ]);

    const requestedShiftCheck = await client.query('SELECT status FROM shifts WHERE id = $1', [
      swapRequest.requested_shift_id,
    ]);

    if (requesterShiftCheck.rows.length === 0 || requestedShiftCheck.rows.length === 0) {
      throw new Error('One or both shifts no longer exist');
    }

    if (
      requesterShiftCheck.rows[0].status === 'cancelled' ||
      requestedShiftCheck.rows[0].status === 'cancelled'
    ) {
      throw new Error('Cannot accept swap for cancelled shifts');
    }

    await client.query('UPDATE shifts SET staff_id = $1, updated_at = NOW() WHERE id = $2', [
      swapRequest.requested_staff_id,
      swapRequest.requester_shift_id,
    ]);

    await client.query('UPDATE shifts SET staff_id = $1, updated_at = NOW() WHERE id = $2', [
      swapRequest.requester_staff_id,
      swapRequest.requested_shift_id,
    ]);

    await client.query(
      `UPDATE shift_swap_requests 
       SET status = 'accepted', resolved_at = NOW() 
       WHERE id = $1`,
      [swapRequestId]
    );

    await client.query('COMMIT');

    const updatedResult = await client.query('SELECT * FROM shift_swap_requests WHERE id = $1', [
      swapRequestId,
    ]);

    return updatedResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectSwapRequest(swapRequestId, staffId) {
  const result = await pool.query(
    `UPDATE shift_swap_requests 
     SET status = 'rejected', resolved_at = NOW() 
     WHERE id = $1 
     AND requested_staff_id = $2 
     AND status = 'pending'
     RETURNING *`,
    [swapRequestId, staffId]
  );

  if (result.rows.length === 0) {
    throw new Error('Swap request not found or you cannot reject it');
  }

  return result.rows[0];
}

export async function cancelSwapRequest(swapRequestId, staffId) {
  const result = await pool.query(
    `UPDATE shift_swap_requests 
     SET status = 'cancelled', resolved_at = NOW() 
     WHERE id = $1 
     AND requester_staff_id = $2 
     AND status = 'pending'
     RETURNING *`,
    [swapRequestId, staffId]
  );

  if (result.rows.length === 0) {
    throw new Error('Swap request not found or you cannot cancel it');
  }

  return result.rows[0];
}

export async function getSwapRequestById(swapRequestId, staffId = null, userId = null) {
  let query = `
    SELECT 
      ssr.*,
      rs.id as requester_shift_id,
      rs.shift_date as requester_shift_date,
      rs.start_time as requester_start_time,
      rs.hours as requester_hours,
      rs.location as requester_location,
      rs.notes as requester_notes,
      rqs.id as requested_shift_id,
      rqs.shift_date as requested_shift_date,
      rqs.start_time as requested_start_time,
      rqs.hours as requested_hours,
      rqs.location as requested_location,
      rqs.notes as requested_notes,
      requester_staff.name as requester_staff_name,
      requested_staff.name as requested_staff_name
    FROM shift_swap_requests ssr
    JOIN shifts rs ON ssr.requester_shift_id = rs.id
    JOIN shifts rqs ON ssr.requested_shift_id = rqs.id
    JOIN staff requester_staff ON ssr.requester_staff_id = requester_staff.id
    JOIN staff requested_staff ON ssr.requested_staff_id = requested_staff.id
    WHERE ssr.id = $1
  `;

  const params = [swapRequestId];

  if (staffId) {
    params.push(staffId);
    query += ` AND (ssr.requester_staff_id = $${params.length} OR ssr.requested_staff_id = $${params.length})`;
  } else if (userId) {
    params.push(userId);
    query += ` AND rs.user_id = $${params.length}`;
  }

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (row.requester_start_time && row.requester_hours) {
    row.requester_end_time = calculateEndTime(
      row.requester_start_time,
      parseFloat(row.requester_hours)
    );
  }
  if (row.requested_start_time && row.requested_hours) {
    row.requested_end_time = calculateEndTime(
      row.requested_start_time,
      parseFloat(row.requested_hours)
    );
  }

  return row;
}
