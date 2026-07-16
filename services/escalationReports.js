import { pool } from '../lib/db.js';
import {
  validateEscalationInput,
  canTransitionEscalationStatus,
  appendTimelineEntry,
  categoryLabel,
} from '../lib/escalationReports.js';
import { createNotification } from './hr.js';

export async function listEscalationReports(userId, { status, staffId } = {}) {
  const clauses = ['er.user_id = $1'];
  const params = [userId];
  let i = 2;
  if (status) {
    clauses.push(`er.status = $${i++}`);
    params.push(status);
  }
  if (staffId != null) {
    clauses.push(`er.staff_id = $${i++}`);
    params.push(staffId);
  }
  const result = await pool.query(
    `SELECT er.*,
            CASE WHEN er.is_anonymous THEN 'Anonymous' ELSE s.name END AS reporter_name
     FROM escalation_reports er
     LEFT JOIN staff s ON s.id = er.staff_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE er.severity
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
       END,
       er.created_at DESC`,
    params
  );
  return result.rows;
}

export async function getEscalationReport(userId, reportId) {
  const result = await pool.query(
    `SELECT er.*,
            CASE WHEN er.is_anonymous THEN 'Anonymous' ELSE s.name END AS reporter_name
     FROM escalation_reports er
     LEFT JOIN staff s ON s.id = er.staff_id
     WHERE er.id = $1 AND er.user_id = $2`,
    [reportId, userId]
  );
  return result.rows[0] || null;
}

export async function createEscalationReport(userId, staffId, data) {
  const err = validateEscalationInput(data);
  if (err) throw new Error(err);

  const timeline = appendTimelineEntry([], {
    actor: data.isAnonymous ? 'anonymous' : 'staff',
    note: 'Report submitted',
    status: 'open',
  });

  const result = await pool.query(
    `INSERT INTO escalation_reports
     (user_id, staff_id, category, severity, status, description, is_anonymous, witnesses, attachments, timeline)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8::jsonb, $9::jsonb)
     RETURNING *`,
    [
      userId,
      data.isAnonymous ? null : staffId,
      data.category,
      data.severity || 'medium',
      String(data.description).trim(),
      Boolean(data.isAnonymous),
      data.witnesses?.trim() || null,
      JSON.stringify(Array.isArray(data.attachments) ? data.attachments : []),
      JSON.stringify(timeline),
    ]
  );

  const row = result.rows[0];
  await createNotification(userId, {
    staffId: data.isAnonymous ? null : staffId,
    type: 'general',
    title: 'New escalation report',
    body: `${categoryLabel(data.category)} report submitted (${data.severity || 'medium'} severity).`,
    meta: { escalationReportId: row.id },
  });

  return row;
}

export async function updateEscalationReport(userId, reportId, data) {
  const current = await getEscalationReport(userId, reportId);
  if (!current) throw new Error('Report not found');

  const nextStatus = data.status ?? current.status;
  if (data.status && !canTransitionEscalationStatus(current.status, data.status)) {
    throw new Error('Invalid status transition');
  }

  let timeline = current.timeline || [];
  if (data.status && data.status !== current.status) {
    timeline = appendTimelineEntry(timeline, {
      actor: 'manager',
      note: data.managerNotes || `Status changed to ${data.status}`,
      status: data.status,
    });
  } else if (data.managerNotes && data.managerNotes !== current.manager_notes) {
    timeline = appendTimelineEntry(timeline, {
      actor: 'manager',
      note: 'Manager notes updated',
      status: current.status,
    });
  }

  const result = await pool.query(
    `UPDATE escalation_reports SET
       status = $1,
       severity = COALESCE($2, severity),
       manager_notes = COALESCE($3, manager_notes),
       actions_taken = COALESCE($4, actions_taken),
       follow_up_date = COALESCE($5, follow_up_date),
       timeline = $6::jsonb,
       updated_at = NOW()
     WHERE id = $7 AND user_id = $8
     RETURNING *`,
    [
      nextStatus,
      data.severity ?? null,
      data.managerNotes ?? null,
      data.actionsTaken ?? null,
      data.followUpDate ?? null,
      JSON.stringify(timeline),
      reportId,
      userId,
    ]
  );

  return result.rows[0];
}
