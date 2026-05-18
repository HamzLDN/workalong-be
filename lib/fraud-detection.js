import { pool } from './db.js';

export async function analyzeFraudPatterns(userId, staffId, daysToAnalyze = 30) {
  const flags = [];

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysToAnalyze);

  const entriesResult = await pool.query(
    `SELECT * FROM time_entries 
     WHERE user_id = $1 AND staff_id = $2 
     AND date >= $3
     ORDER BY date DESC`,
    [userId, staffId, startDate.toISOString().split('T')[0]]
  );

  const entries = entriesResult.rows;

  if (entries.length === 0) return flags;

  const exactTimeCount = entries.filter((e) => {
    const hours = parseFloat(e.hours_worked);
    return hours === Math.floor(hours) && hours > 0;
  }).length;

  const exactTimePercentage = (exactTimeCount / entries.length) * 100;

  if (exactTimePercentage > 80 && entries.length >= 5) {
    flags.push({
      type: 'exact-times',
      severity: 'medium',
      description: `${exactTimePercentage.toFixed(0)}% of time entries are exact hours (e.g., 8.0, 9.0). Real work rarely has perfect timing.`,
      count: exactTimeCount,
      total: entries.length,
    });
  }

  const manualCount = entries.filter((e) => e.entry_type === 'manual' || !e.entry_type).length;
  const manualPercentage = (manualCount / entries.length) * 100;

  if (manualPercentage === 100 && entries.length >= 10) {
    flags.push({
      type: 'always-manual',
      severity: 'medium',
      description: `100% of entries are manual. Consider using clock in/out for more accurate tracking.`,
      count: manualCount,
      total: entries.length,
    });
  }

  const editedCount = entries.filter((e) => e.is_edited && e.edit_count >= 2).length;
  const editPercentage = (editedCount / entries.length) * 100;

  if (editPercentage > 40 && entries.length >= 5) {
    flags.push({
      type: 'frequent-edits',
      severity: 'high',
      description: `${editPercentage.toFixed(0)}% of entries have been edited multiple times. This may indicate uncertainty or manipulation.`,
      count: editedCount,
      total: entries.length,
    });
  }

  const noActivityCount = entries.filter((e) => {
    if (!e.clock_in_time || !e.last_activity_time) return false;

    const clockIn = new Date(e.clock_in_time);
    const lastActivity = new Date(e.last_activity_time);
    const diffMinutes = (lastActivity - clockIn) / (1000 * 60);

    return diffMinutes < 5 && parseFloat(e.hours_worked) >= 4;
  }).length;

  if (noActivityCount > 0) {
    flags.push({
      type: 'no-activity',
      severity: 'high',
      description: `${noActivityCount} entries show clock-in but minimal system activity despite claiming 4+ hours.`,
      count: noActivityCount,
      total: entries.length,
    });
  }

  const hourPatterns = entries.map((e) => parseFloat(e.hours_worked).toFixed(1));
  const uniqueHours = new Set(hourPatterns);

  if (uniqueHours.size <= 2 && entries.length >= 10) {
    flags.push({
      type: 'pattern-repetition',
      severity: 'low',
      description: `Only ${uniqueHours.size} different hour values across ${entries.length} entries. Real work patterns vary more.`,
      count: uniqueHours.size,
      total: entries.length,
    });
  }

  return flags;
}

const RESOLVED_COOLDOWN_DAYS = 14;

export async function createFraudFlag(userId, staffId, flag, timeEntryId = null) {
  const existingFlag = await pool.query(
    `SELECT id FROM fraud_flags 
     WHERE user_id = $1 AND staff_id = $2 AND flag_type = $3 AND is_resolved = FALSE
     LIMIT 1`,
    [userId, staffId, flag.type]
  );

  if (existingFlag.rows.length > 0) {
    const result = await pool.query(
      `UPDATE fraud_flags 
       SET description = $1, 
           severity = $2
       WHERE id = $3
       RETURNING *`,
      [flag.description, flag.severity, existingFlag.rows[0].id]
    );
    return result.rows[0];
  }

  const recentlyResolved = await pool.query(
    `SELECT id FROM fraud_flags 
     WHERE user_id = $1 AND staff_id = $2 AND flag_type = $3 AND is_resolved = TRUE
       AND resolved_at > NOW() - INTERVAL '1 day' * $4
     LIMIT 1`,
    [userId, staffId, flag.type, RESOLVED_COOLDOWN_DAYS]
  );

  if (recentlyResolved.rows.length > 0) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO fraud_flags 
     (user_id, staff_id, time_entry_id, flag_type, severity, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, staffId, timeEntryId, flag.type, flag.severity, flag.description]
  );

  return result.rows[0];
}

export async function getFraudFlags(userId, staffId = null, includeResolved = false) {
  let query = `
    SELECT f.*, s.name as staff_name, s.role
    FROM fraud_flags f
    JOIN staff s ON f.staff_id = s.id
    WHERE f.user_id = $1
  `;

  const params = [userId];

  if (staffId) {
    params.push(staffId);
    query += ` AND f.staff_id = $${params.length}`;
  }

  if (!includeResolved) {
    query += ` AND f.is_resolved = FALSE`;
  }

  query += ' ORDER BY f.created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

export async function resolveFraudFlag(flagId, userId, notes) {
  const result = await pool.query(
    `UPDATE fraud_flags
     SET is_resolved = TRUE,
         resolved_by = $1,
         resolved_at = NOW(),
         resolution_notes = $2
     WHERE id = $3
     RETURNING *`,
    [userId, notes, flagId]
  );

  return result.rows[0];
}

export async function getFraudStats(userId) {
  const result = await pool.query(
    `SELECT 
       COUNT(*) as total_flags,
       COUNT(CASE WHEN is_resolved = FALSE THEN 1 END) as active_flags,
       COUNT(CASE WHEN severity = 'high' AND is_resolved = FALSE THEN 1 END) as high_severity,
       COUNT(DISTINCT staff_id) as flagged_staff_count
     FROM fraud_flags
     WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0];
}

export async function analyzeAllStaff(userId) {
  const staffResult = await pool.query('SELECT id FROM staff WHERE user_id = $1 AND status = $2', [
    userId,
    'active',
  ]);

  const allFlags = [];

  for (const staff of staffResult.rows) {
    const flags = await analyzeFraudPatterns(userId, staff.id);

    for (const flag of flags) {
      const created = await createFraudFlag(userId, staff.id, flag);
      if (created) allFlags.push(created);
    }
  }

  return allFlags;
}
