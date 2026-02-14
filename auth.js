import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool } from './db.js';

export async function createUser(email, password, name, company = null) {
  const passwordHash = await bcrypt.hash(password, 10);
  
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) 
     VALUES (LOWER($1), $2, $3) 
     RETURNING id, email, name, is_verified, subscription_status, subscription_plan, created_at`,
    [email, passwordHash, name]
  );
  
  return result.rows[0];
}

export async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  
  return result.rows[0];
}

// Hash password
export async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export async function createSession(userId, ipAddress, userAgent) {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent) 
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, expiresAt, ipAddress, userAgent]
  );
  
  return { sessionId, expiresAt };
}

export async function getSession(sessionId) {
  const result = await pool.query(
    `SELECT s.*, u.id as user_id, u.email, u.name, u.is_verified, 
            u.subscription_status, u.subscription_plan
     FROM sessions s 
     JOIN users u ON s.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId]
  );
  
  return result.rows[0];
}

export async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function cleanupExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
}

export async function createLoginCode(userId, email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  
  await pool.query('DELETE FROM login_codes WHERE user_id = $1', [userId]);
  
  const result = await pool.query(
    `INSERT INTO login_codes (user_id, code, email, expires_at) 
     VALUES ($1, $2, $3, $4) 
     RETURNING id, code, email, expires_at`,
    [userId, code, email, expiresAt]
  );
  
  return result.rows[0];
}

export async function verifyLoginCode(userId, code) {
  const result = await pool.query(
    `SELECT * FROM login_codes 
     WHERE user_id = $1 AND code = $2 AND expires_at > NOW() AND used_at IS NULL`,
    [userId, code]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  // Mark code as used
  await pool.query(
    'UPDATE login_codes SET used_at = NOW() WHERE id = $1',
    [result.rows[0].id]
  );
  
  return result.rows[0];
}

// Create password reset token
export async function createPasswordResetToken(email) {
  const user = await findUserByEmail(email);
  if (!user) {
    return null; // Don't reveal if user exists
  }
  
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  
  // Delete any existing tokens for this user
  await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
  
  const result = await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token, email, expires_at) 
     VALUES ($1, $2, $3, $4) 
     RETURNING id, token, email, expires_at`,
    [user.id, token, email, expiresAt]
  );
  
  return {
    token: result.rows[0].token,
    user: user
  };
}

// Verify password reset token
export async function verifyPasswordResetToken(token) {
  const result = await pool.query(
    `SELECT prt.*, u.id as user_id, u.email, u.name
     FROM password_reset_tokens prt
     JOIN users u ON prt.user_id = u.id
     WHERE prt.token = $1 AND prt.expires_at > NOW() AND prt.used_at IS NULL`,
    [token]
  );
  
  return result.rows[0] || null;
}

// Reset password with token
export async function resetPasswordWithToken(token, newPassword) {
  const tokenData = await verifyPasswordResetToken(token);
  if (!tokenData) {
    return null;
  }
  
  const passwordHash = await bcrypt.hash(newPassword, 10);
  
  // Update password
  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [passwordHash, tokenData.user_id]
  );
  
  // Mark token as used
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
    [tokenData.id]
  );
  
  return { success: true };
}
