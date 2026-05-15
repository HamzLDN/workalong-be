import { pool } from './db.js';

export async function logActivity(userId, activityData) {
  const {
    type,
    title,
    description,
    staffId = null,
    shiftId = null,
    icon = '',
    color = 'blue',
  } = activityData;

  try {
    const result = await pool.query(
      `INSERT INTO activity_feed 
       (user_id, activity_type, activity_title, activity_description, 
        staff_id, shift_id, icon, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, type, title, description, staffId, shiftId, icon, color]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error logging activity:', error);
    return null;
  }
}

/**
 * Activity feed entries relevant to a manager’s direct reports (and their shifts).
 */
export async function getPortalTeamActivities(
  companyUserId,
  managerStaffId,
  limit = 50,
  offset = 0
) {
  try {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 150);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const result = await pool.query(
      `SELECT 
         af.id,
         af.activity_type,
         af.activity_title,
         af.activity_description,
         af.staff_id,
         af.shift_id,
         af.icon,
         af.color,
         af.created_at,
         sh.shift_date,
         sh.start_time,
         sh.hours,
         COALESCE(fs.name, ts.name) AS staff_name,
         COALESCE(fs.lastname, ts.lastname) AS staff_lastname
       FROM activity_feed af
       LEFT JOIN shifts sh ON sh.id = af.shift_id
       LEFT JOIN staff fs ON fs.id = af.staff_id
       LEFT JOIN staff ts ON ts.id = sh.staff_id
       WHERE af.user_id = $1
         AND (
           af.staff_id IN (SELECT id FROM staff WHERE manager_id = $2)
           OR sh.staff_id IN (SELECT id FROM staff WHERE manager_id = $2)
         )
       ORDER BY af.created_at DESC
       LIMIT $3 OFFSET $4`,
      [companyUserId, managerStaffId, lim, off]
    );

    return result.rows;
  } catch (error) {
    console.error('Error fetching portal team activities:', error);
    return [];
  }
}

export async function getActivities(userId, limit = 20, offset = 0) {
  try {
    const result = await pool.query(
      `SELECT 
        af.*,
        s.name as staff_name,
        sh.shift_date,
        sh.start_time,
        sh.hours
       FROM activity_feed af
       LEFT JOIN staff s ON s.id = af.staff_id
       LEFT JOIN shifts sh ON sh.id = af.shift_id
       WHERE af.user_id = $1
       ORDER BY af.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows;
  } catch (error) {
    console.error('Error fetching activities:', error);
    return [];
  }
}

export async function getActivityStats(userId) {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_activities,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today_activities,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as week_activities,
        COUNT(DISTINCT activity_type) as activity_types
       FROM activity_feed
       WHERE user_id = $1`,
      [userId]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error fetching activity stats:', error);
    return null;
  }
}

export async function cleanupOldActivities() {
  try {
    const result = await pool.query(
      `DELETE FROM activity_feed 
       WHERE created_at < NOW() - INTERVAL '30 days'
       RETURNING id`
    );

    console.log(`Cleaned up ${result.rowCount} old activities`);
    return result.rowCount;
  } catch (error) {
    console.error('Error cleaning up activities:', error);
    return 0;
  }
}

export async function logStaffActivity(userId, staffId, staffName, action) {
  const activities = {
    created: {
      type: 'staff_added',
      title: 'New staff member added',
      description: `${staffName} was added to your team`,
      icon: '',
      color: 'green',
    },
    updated: {
      type: 'staff_updated',
      title: 'Staff member updated',
      description: `${staffName}'s information was updated`,
      icon: '',
      color: 'blue',
    },
    deleted: {
      type: 'staff_deleted',
      title: 'Staff member removed',
      description: `${staffName} was removed from your team`,
      icon: '',
      color: 'red',
    },
  };

  const activity = activities[action];
  if (activity) {
    /** Avoid FK violations if staff row was removed or id is malformed (async log after response). */
    let resolvedStaffId = null;
    if (staffId != null && staffId !== '') {
      const n = parseInt(String(staffId), 10);
      if (!Number.isNaN(n) && n > 0) {
        const chk = await pool.query('SELECT 1 FROM staff WHERE id = $1', [n]);
        if (chk.rows.length > 0) resolvedStaffId = n;
      }
    }
    return logActivity(userId, { ...activity, staffId: resolvedStaffId });
  }
}

export async function logShiftActivity(
  userId,
  shiftDataOrStaffId,
  actionOrShiftId,
  actionOrDescription,
  description
) {
  let shiftId, staffName, date, startTime, hours, finalAction, finalDescription;

  // Determine which calling pattern is being used
  if (typeof shiftDataOrStaffId === 'object' && shiftDataOrStaffId !== null) {
    // Pattern 1: Object-based call
    const shiftData = shiftDataOrStaffId;
    shiftId = shiftData.shiftId;
    staffName = shiftData.staffName;
    date = shiftData.date;
    startTime = shiftData.startTime;
    hours = shiftData.hours;
    finalAction = actionOrShiftId;
    finalDescription = null;
  } else {
    // Pattern 2: Individual parameters (backward compatibility)
    const staffId = shiftDataOrStaffId;
    shiftId = actionOrShiftId;
    finalAction = actionOrDescription;
    finalDescription = description;

    // Try to fetch shift details if we have shiftId
    if (shiftId) {
      try {
        const shiftResult = await pool.query(
          `SELECT s.*, st.name as staff_name 
           FROM shifts s 
           LEFT JOIN staff st ON s.staff_id = st.id 
           WHERE s.id = $1`,
          [shiftId]
        );
        if (shiftResult.rows.length > 0) {
          const shift = shiftResult.rows[0];
          staffName = shift.staff_name;
          date = shift.shift_date;
          startTime = shift.start_time;
          hours = shift.hours;
        }
      } catch (err) {
        // If we can't fetch shift details, use provided description
        console.error('Error fetching shift details for activity:', err);
      }
    }
  }

  // Calculate end time display from start time + hours
  let timeDisplay = startTime || '';
  if (startTime && hours) {
    const [startHour, startMin] = startTime.split(':').map(Number);
    const endMinutes = startHour * 60 + startMin + hours * 60;
    const endHour = Math.floor(endMinutes / 60) % 24;
    const endMin = endMinutes % 60;
    const endTimeStr = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;
    timeDisplay = `${startTime}-${endTimeStr}`;
  } else if (startTime && hours !== null && hours !== undefined) {
    timeDisplay = `${startTime} (${hours}h)`;
  }

  const activities = {
    created: {
      type: 'shift_created',
      title: 'Shift scheduled',
      description: finalDescription || `Created shift for ${staffName} on ${date} ${timeDisplay}`,
      icon: '',
      color: 'blue',
    },
    updated: {
      type: 'shift_updated',
      title: 'Shift modified',
      description: finalDescription || `Updated ${staffName}'s shift on ${date}`,
      icon: '',
      color: 'blue',
    },
    deleted: {
      type: 'shift_deleted',
      title: 'Shift cancelled',
      description: finalDescription || `Cancelled ${staffName}'s shift on ${date}`,
      icon: '',
      color: 'red',
    },
    bulk_created: {
      type: 'shifts_bulk_created',
      title: 'Bulk shifts created',
      description: finalDescription || `Created multiple shifts for ${staffName}`,
      icon: '',
      color: 'green',
    },
    approved: {
      type: 'shift_approved',
      title: 'Shift approved',
      description: finalDescription || `Approved shift for ${staffName}`,
      icon: '',
      color: 'green',
    },
  };

  const activity = activities[finalAction];
  if (activity) {
    return logActivity(userId, { ...activity, shiftId });
  }
}

export async function logPaymentActivity(userId, amount, staffName) {
  return logActivity(userId, {
    type: 'payment_made',
    title: 'Payment processed',
    description: `Paid ${staffName} £${amount}`,
    icon: '',
    color: 'green',
  });
}

export async function logAuthActivity(userId, action) {
  const activities = {
    signin: {
      type: 'user_signin',
      title: 'Signed in',
      description: 'You signed in to your account',
      icon: '',
      color: 'blue',
    },
    signout: {
      type: 'user_signout',
      title: 'Signed out',
      description: 'You signed out of your account',
      icon: '',
      color: 'gray',
    },
    signup: {
      type: 'user_signup',
      title: 'Welcome!',
      description: 'Your account was created successfully',
      icon: '',
      color: 'purple',
    },
  };

  const activity = activities[action];
  if (activity) {
    return logActivity(userId, activity);
  }
}

export async function logSubscriptionActivity(userId, plan) {
  return logActivity(userId, {
    type: 'subscription_upgraded',
    title: 'Account upgraded',
    description: `Upgraded to ${plan} plan`,
    icon: '',
    color: 'purple',
  });
}
