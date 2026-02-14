import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import pool from './db.js';

export async function findStaffByUsername(username) {
  const result = await pool.query(
    `SELECT s.*, u.id as company_user_id, u.name as company_name
     FROM staff s
     JOIN users u ON s.user_id = u.id
     WHERE s.username = $1`,
    [username]
  );
  
  return result.rows[0];
}

export async function verifyStaffPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export async function createStaffSession(staffId, ipAddress, userAgent) {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  await pool.query(
    `INSERT INTO staff_sessions (id, staff_id, expires_at, ip_address, user_agent) 
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, staffId, expiresAt, ipAddress, userAgent]
  );
  
  return { sessionId, expiresAt };
}

export async function getStaffSession(sessionId) {
  const result = await pool.query(
    `SELECT ss.*, s.id as staff_id, s.name, s.email, s.role, s.user_id as company_user_id,
            s.hourly_rate, s.employment_type, u.name as company_name
     FROM staff_sessions ss 
     JOIN staff s ON ss.staff_id = s.id 
     JOIN users u ON s.user_id = u.id
     WHERE ss.id = $1 AND ss.expires_at > NOW()`,
    [sessionId]
  );
  
  return result.rows[0];
}

export async function deleteStaffSession(sessionId) {
  await pool.query('DELETE FROM staff_sessions WHERE id = $1', [sessionId]);
}

export async function cleanupExpiredStaffSessions() {
  await pool.query('DELETE FROM staff_sessions WHERE expires_at < NOW()');
}
