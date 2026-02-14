import express from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { pool } from '../db.js';
import {
  createUser,
  findUserByEmail,
  verifyPassword,
  createSession,
  getSession,
  deleteSession,
  createLoginCode,
  verifyLoginCode,
  createPasswordResetToken,
  verifyPasswordResetToken,
  resetPasswordWithToken
} from '../auth.js';
import { logAuthActivity } from '../activity.js';
import { logSecurityEvent } from '../api-security.js';
import { createRateLimiter } from '../middleware/security.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

async function getUserWithSubscription(userId) {
  try {
    const r = await pool.query(
      'SELECT id, email, name, is_verified, subscription_status, subscription_plan, subscription_staff_limit FROM users WHERE id = $1',
      [userId]
    );
    const row = r.rows[0];
    if (row && row.subscription_staff_limit == null) row.subscription_staff_limit = null;
    return row;
  } catch (colErr) {
    if (colErr.code === '42703' || (colErr.message && colErr.message.includes('subscription_staff_limit'))) {
      const r = await pool.query(
        'SELECT id, email, name, is_verified, subscription_status, subscription_plan FROM users WHERE id = $1',
        [userId]
      );
      const row = r.rows[0];
      if (row) row.subscription_staff_limit = null;
      return row;
    }
    throw colErr;
  }
}

router.post('/signup', createRateLimiter({ limitPerMinute: 5, limitPerHour: 20 }), async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const user = await createUser(email, password, name);
    const { sessionId, expiresAt } = await createSession(user.id, req.ip, req.headers['user-agent']);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isVerified: user.is_verified,
        subscriptionStatus: user.subscription_status,
        subscriptionPlan: user.subscription_plan,
        latitude: user.latitude,
        longitude: user.longitude
      },
      session: { id: sessionId, expiresAt }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'An error occurred during signup' });
  }
});

router.post('/signin', createRateLimiter({ limitPerMinute: 5, limitPerHour: 20 }), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const totpEnabled = user.totp_enabled === true;
    const email2FAEnabled = user.email_2fa_enabled !== false;
    if (totpEnabled && email2FAEnabled) {
      return res.json({
        message: 'TOTP verification required. After verifying, you will need to enter the code sent to your email.',
        email: user.email,
        requires2FA: true,
        requiresTOTP: true,
        requiresEmailCode: true
      });
    }
    if (totpEnabled) {
      return res.json({
        message: 'TOTP verification required',
        email: user.email,
        requires2FA: true,
        requiresTOTP: true
      });
    }
    if (email2FAEnabled) {
      const loginCode = await createLoginCode(user.id, user.email);
      const { sendLoginCodeEmail } = await import('../email.js');
      sendLoginCodeEmail(user.email, user.name, loginCode.code).catch(err => console.error('Failed to send login code email:', err));
      return res.json({
        message: 'Verification code sent to your email',
        email: user.email,
        requires2FA: true,
        requiresEmailCode: true
      });
    }
    const { sessionId, expiresAt } = await createSession(user.id, req.ip, req.headers['user-agent']);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logAuthActivity(user.id, 'signin').catch(err => console.error('Failed to log signin activity:', err));
    const fullUser = await getUserWithSubscription(user.id);
    res.json({
      message: 'Signed in successfully',
      user: {
        id: fullUser.id,
        email: fullUser.email,
        name: fullUser.name,
        isVerified: fullUser.is_verified,
        subscriptionStatus: fullUser.subscription_status,
        subscriptionPlan: fullUser.subscription_plan,
        subscriptionStaffLimit: fullUser.subscription_staff_limit != null ? fullUser.subscription_staff_limit : null
      },
      session: { id: sessionId, expiresAt },
      requires2FA: false
    });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({ error: 'An error occurred during signin' });
  }
});

router.post('/verify-code', async (req, res) => {
  try {
    const { email, code, isTOTP } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email' });
    }
    const totpEnabled = user.totp_enabled === true;
    const email2FAEnabled = user.email_2fa_enabled !== false;
    let userId = user.id;
    let isValid = false;
    if (isTOTP && totpEnabled && user.totp_secret) {
      try {
        const speakeasy = await import('speakeasy');
        isValid = speakeasy.default.totp.verify({
          secret: user.totp_secret,
          encoding: 'base32',
          token: code,
          window: 2
        });
        if (isValid && totpEnabled && email2FAEnabled) {
          const loginCode = await createLoginCode(user.id, user.email);
          const { sendLoginCodeEmail } = await import('../email.js');
          sendLoginCodeEmail(user.email, user.name, loginCode.code).catch(err => console.error('Failed to send login code email:', err));
          return res.json({
            message: 'TOTP code verified. Verification code sent to your email.',
            email: user.email,
            requires2FA: true,
            requiresEmailCode: true,
            totpCodeVerified: true
          });
        }
      } catch (totpErr) {
        console.error('TOTP verification error:', totpErr);
        return res.status(401).json({ error: 'Failed to verify TOTP code' });
      }
    } else {
      const loginCode = await verifyLoginCode(user.id, code);
      if (loginCode) {
        isValid = true;
        userId = loginCode.user_id;
      }
    }
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }
    const { sessionId, expiresAt } = await createSession(userId, req.ip, req.headers['user-agent']);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logAuthActivity(userId, 'signin').catch(err => console.error('Failed to log signin activity:', err));
    const fullUser = await getUserWithSubscription(userId);
    if (!fullUser) {
      return res.status(500).json({ error: 'User not found after login' });
    }
    res.json({
      message: 'Signed in successfully',
      user: {
        id: fullUser.id,
        email: fullUser.email,
        name: fullUser.name,
        isVerified: fullUser.is_verified,
        subscriptionStatus: fullUser.subscription_status,
        subscriptionPlan: fullUser.subscription_plan,
        subscriptionStaffLimit: fullUser.subscription_staff_limit != null ? fullUser.subscription_staff_limit : null
      },
      session: { id: sessionId, expiresAt }
    });
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({ error: 'An error occurred while verifying code' });
  }
});

router.post('/verify-totp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and TOTP code are required' });
    }
    const user = await findUserByEmail(email);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'TOTP not enabled for this account' });
    }
    const speakeasy = await import('speakeasy');
    const isValid = speakeasy.default.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: code,
      window: 2
    });
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }
    const { sessionId, expiresAt } = await createSession(user.id, req.ip, req.headers['user-agent']);
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logAuthActivity(user.id, 'signin').catch(err => console.error('Failed to log signin activity:', err));
    const fullUser = await getUserWithSubscription(user.id);
    res.json({
      message: 'Signed in successfully',
      user: {
        id: fullUser.id,
        email: fullUser.email,
        name: fullUser.name,
        isVerified: fullUser.is_verified,
        subscriptionStatus: fullUser.subscription_status,
        subscriptionPlan: fullUser.subscription_plan,
        subscriptionStaffLimit: fullUser.subscription_staff_limit != null ? fullUser.subscription_staff_limit : null
      },
      session: { id: sessionId, expiresAt }
    });
  } catch (error) {
    console.error('Verify TOTP error:', error);
    res.status(500).json({ error: 'An error occurred while verifying TOTP code' });
  }
});

router.get('/2fa/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT email_2fa_enabled, totp_enabled FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const row = result.rows[0];
    res.json({
      emailEnabled: row.email_2fa_enabled !== false,
      totpEnabled: row.totp_enabled === true,
      enabled: (row.email_2fa_enabled !== false) || (row.totp_enabled === true)
    });
  } catch (error) {
    if (error.code === '42703') {
      return res.json({ emailEnabled: true, totpEnabled: false, enabled: true });
    }
    console.error('Get 2FA status error:', error);
    res.status(500).json({ error: 'Failed to get 2FA status' });
  }
});

router.post('/2fa/email/enable', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET email_2fa_enabled = TRUE WHERE id = $1', [req.userId]);
    logAuthActivity(req.userId, 'email_2fa_enabled').catch(err => console.error('Failed to log email 2FA enabled activity:', err));
    res.json({ message: 'Email two-factor authentication enabled successfully' });
  } catch (error) {
    console.error('Enable email 2FA error:', error);
    res.status(500).json({ error: 'Failed to enable email 2FA' });
  }
});

router.post('/2fa/email/disable', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET email_2fa_enabled = FALSE WHERE id = $1', [req.userId]);
    logAuthActivity(req.userId, 'email_2fa_disabled').catch(err => console.error('Failed to log email 2FA disabled activity:', err));
    res.json({ message: 'Email two-factor authentication disabled successfully' });
  } catch (error) {
    console.error('Disable email 2FA error:', error);
    res.status(500).json({ error: 'Failed to disable email 2FA' });
  }
});

router.post('/2fa/totp/generate', requireAuth, async (req, res) => {
  try {
    const speakeasy = await import('speakeasy');
    const QRCode = await import('qrcode');
    const userResult = await pool.query('SELECT email, totp_secret FROM users WHERE id = $1', [req.userId]);
    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    const email = userResult.rows[0]?.email || 'user';
    const existingSecret = userResult.rows[0]?.totp_secret;
    let secret;
    let qrCodeDataURL;
    if (existingSecret) {
      const secretBase32 = existingSecret.trim().toUpperCase();
      if (existingSecret !== secretBase32) {
        await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secretBase32, req.userId]);
      }
      secret = {
        base32: secretBase32,
        otpauth_url: speakeasy.default.otpauthURL({
          secret: secretBase32,
          encoding: 'base32',
          label: `Work Along (${email})`,
          issuer: 'Work Along'
        })
      };
      qrCodeDataURL = await QRCode.default.toDataURL(secret.otpauth_url);
      res.json({ secret: secret.base32, qrCode: qrCodeDataURL, otpauthUrl: secret.otpauth_url, reused: true });
    } else {
      secret = speakeasy.default.generateSecret({ name: `Work Along (${email})`, issuer: 'Work Along' });
      const secretBase32 = secret.base32.trim().toUpperCase();
      await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secretBase32, req.userId]);
      secret.base32 = secretBase32;
      secret.otpauth_url = speakeasy.default.otpauthURL({
        secret: secretBase32,
        encoding: 'base32',
        label: `Work Along (${email})`,
        issuer: 'Work Along'
      });
      qrCodeDataURL = await QRCode.default.toDataURL(secret.otpauth_url);
      res.json({ secret: secret.base32, qrCode: qrCodeDataURL, otpauthUrl: secret.otpauth_url, reused: false });
    }
  } catch (error) {
    console.error('Generate TOTP secret error:', error);
    res.status(500).json({ error: 'Failed to generate TOTP secret' });
  }
});

router.post('/2fa/totp/enable', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Valid 6-digit code is required' });
    }
    const userResult = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0 || !userResult.rows[0].totp_secret) {
      return res.status(400).json({ error: 'No TOTP secret found. Please generate one first.' });
    }
    let secret = (userResult.rows[0].totp_secret || '').trim().toUpperCase();
    const speakeasy = await import('speakeasy');
    const codeStr = String(code).trim().replace(/\D/g, '');
    if (codeStr.length !== 6) {
      return res.status(400).json({ error: 'Code must be exactly 6 digits' });
    }
    let isValid = speakeasy.default.totp.verify({ secret, encoding: 'base32', token: codeStr, window: 2 });
    if (!isValid) {
      isValid = speakeasy.default.totp.verify({ secret, encoding: 'base32', token: codeStr, window: 4 });
    }
    if (!isValid) {
      return res.status(400).json({
        error: 'Invalid verification code. Please try again. Make sure:\n1. Your device clock is synchronized\n2. You\'re using the code from the QR code you just scanned\n3. The code hasn\'t expired (codes refresh every 30 seconds)\n\nIf this persists, try generating a new QR code.'
      });
    }
    await pool.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [req.userId]);
    logAuthActivity(req.userId, 'totp_2fa_enabled').catch(err => console.error('Failed to log TOTP 2FA enabled activity:', err));
    res.json({ message: 'Google Authenticator (TOTP) enabled successfully. Both email and TOTP 2FA are now active for enhanced security.' });
  } catch (error) {
    console.error('Enable TOTP error:', error);
    res.status(500).json({ error: 'Failed to enable TOTP' });
  }
});

router.post('/2fa/totp/disable', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET totp_enabled = FALSE WHERE id = $1', [req.userId]);
    logAuthActivity(req.userId, 'totp_2fa_disabled').catch(err => console.error('Failed to log TOTP 2FA disabled activity:', err));
    res.json({ message: 'Google Authenticator (TOTP) disabled successfully. Your secret is saved - you can re-enable without scanning a new QR code.' });
  } catch (error) {
    console.error('Disable TOTP error:', error);
    res.status(500).json({ error: 'Failed to disable TOTP' });
  }
});

router.post('/2fa/totp/reset', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1', [req.userId]);
    logAuthActivity(req.userId, 'totp_2fa_reset').catch(err => console.error('Failed to log TOTP 2FA reset activity:', err));
    res.json({ message: 'TOTP secret cleared. Please generate a new QR code.' });
  } catch (error) {
    console.error('Reset TOTP error:', error);
    res.status(500).json({ error: 'Failed to reset TOTP' });
  }
});

router.get('/csrf-token', async (req, res) => {
  try {
    let sessionId = req.cookies.sessionId;
    if (!sessionId && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (!authHeader.startsWith('Bearer wak_')) {
        sessionId = authHeader.replace('Bearer ', '');
      }
    }
    if (!sessionId) {
      return res.status(401).json({ error: 'No session found. Please sign in first.' });
    }
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    if (!req.cookies.sessionId && sessionId) {
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
    }
    const csrfToken = crypto
      .createHash('sha256')
      .update(sessionId + (process.env.SESSION_SECRET || config.sessionSecret || 'change-this-secret-key-in-production'))
      .digest('hex');
    res.json({ csrfToken });
  } catch (error) {
    console.error('CSRF token generation error:', error);
    res.status(500).json({ error: 'Failed to generate CSRF token' });
  }
});

router.get('/me', async (req, res) => {
  try {
    let sessionId = req.cookies.sessionId;
    let fromCookie = true;
    if (!sessionId && req.headers.authorization) {
      sessionId = req.headers.authorization.replace('Bearer ', '');
      fromCookie = false;
    }
    if (!sessionId) {
      return res.status(401).json({ error: 'No session provided' });
    }
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const csrfToken = req.headers['x-csrf-token'];
    if (!csrfToken) {
      await logSecurityEvent('csrf_token_missing', {
        userId: session.user_id,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      return res.status(403).json({
        error: 'CSRF token required. Include X-CSRF-Token header. Get token from /api/auth/csrf-token endpoint.'
      });
    }
    const expectedToken = crypto
      .createHash('sha256')
      .update(sessionId + (process.env.SESSION_SECRET || config.sessionSecret || 'change-this-secret-key-in-production'))
      .digest('hex');
    if (csrfToken !== expectedToken) {
      await logSecurityEvent('csrf_token_invalid', {
        userId: session.user_id,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    if (!fromCookie && sessionId) {
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
    }
    const user = await getUserWithSubscription(session.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isVerified: user.is_verified,
        subscriptionStatus: user.subscription_status,
        subscriptionPlan: user.subscription_plan,
        subscriptionStaffLimit: user.subscription_staff_limit != null ? user.subscription_staff_limit : null
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const tokenData = await createPasswordResetToken(email);
    if (tokenData) {
      const { sendPasswordResetEmail } = await import('../email.js');
      sendPasswordResetEmail(tokenData.user.email, tokenData.user.name, tokenData.token).catch(err =>
        console.error('Failed to send password reset email:', err)
      );
    }
    res.json({
      message: 'If an account with that email exists, a password reset link has been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    await resetPasswordWithToken(token, password);
    res.json({
      message: 'Password reset successfully. You can now sign in with your new password.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    if (error.message === 'Invalid or expired token') {
      return res.status(401).json({ error: 'Invalid or expired reset token. Please request a new password reset.' });
    }
    res.status(500).json({ error: 'An error occurred while resetting password' });
  }
});

router.post('/signout', async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
    if (!sessionId) {
      return res.status(400).json({ error: 'No session provided' });
    }
    await deleteSession(sessionId);
    res.clearCookie('sessionId', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    res.json({ message: 'Signed out successfully' });
  } catch (error) {
    console.error('Signout error:', error);
    res.status(500).json({ error: 'An error occurred during signout' });
  }
});

router.put('/profile', async (req, res) => {
  try {
    let sessionId = req.cookies.sessionId || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const { name, email, latitude, longitude } = req.body;
    
    // Validate email if provided
    if (email !== undefined && email !== null) {
      if (typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'Email cannot be empty' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      // Check if email is already taken by another user
      const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.trim(), session.user_id]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Email is already in use by another account' });
      }
    }
    
    // Validate latitude/longitude if provided
    if (latitude !== undefined && latitude !== null) {
      if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
        return res.status(400).json({ error: 'Invalid latitude. Must be between -90 and 90' });
      }
    }
    if (longitude !== undefined && longitude !== null) {
      if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
        return res.status(400).json({ error: 'Invalid longitude. Must be between -180 and 180' });
      }
    }
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined && name !== null) {
      updates.push(`name = $${paramCount++}`);
      values.push(name.trim() || null);
    }
    if (email !== undefined && email !== null) {
      updates.push(`email = $${paramCount++}`);
      values.push(email.trim());
      // If email changed, reset verification status
      updates.push(`is_verified = false`);
    }
    if (latitude !== undefined) {
      updates.push(`latitude = $${paramCount++}`);
      values.push(latitude);
    }
    if (longitude !== undefined) {
      updates.push(`longitude = $${paramCount++}`);
      values.push(longitude);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push('updated_at = NOW()');
    values.push(session.user_id);
    const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, email, name, is_verified, subscription_status, subscription_plan, latitude, longitude`;
    const result = await pool.query(updateQuery, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'Profile updated successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({ error: 'Email is already in use by another account' });
    }
    res.status(500).json({ error: 'An error occurred while updating profile' });
  }
});

export default router;
