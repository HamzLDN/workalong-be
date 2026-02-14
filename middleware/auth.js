import crypto from 'crypto';
import { config } from '../config.js';
import { pool } from '../db.js';
import { getSession } from '../auth.js';
import { getStaffSession } from '../staff-auth.js';
import { logSecurityEvent } from '../api-security.js';

export async function requireAuth(req, res, next) {
  try {
    if (req.userId && req.apiKey) {
      return next();
    }

    const apiKey = req.headers['x-api-key'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer wak_')
        ? req.headers.authorization.replace('Bearer ', '')
        : null);

    if (apiKey && apiKey.startsWith('wak_')) {
      const { verifyApiKey } = await import('../api-security.js');
      const keyData = await verifyApiKey(apiKey);
      if (keyData) {
        req.userId = keyData.user_id;
        req.user = { id: keyData.user_id, email: keyData.email, name: keyData.name };
        req.apiKey = keyData;
        return next();
      }
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    let sessionId = req.cookies.sessionId;
    let fromCookie = true;
    if (!sessionId && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      sessionId = authHeader.replace('Bearer ', '');
      fromCookie = false;
      if (sessionId && sessionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        logSecurityEvent('session_token_in_authorization_header', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.path,
          requestMethod: req.method,
          details: { message: 'Session token used in Authorization header.', tokenPrefix: sessionId.substring(0, 8) },
          severity: 'info'
        }).catch(err => console.error('Failed to log security event:', err));
      }
    }

    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      return res.status(401).json({ error: 'No valid session provided' });
    }

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    if (!fromCookie && sessionId) {
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
    }

    req.userId = session.user_id;
    req.user = { id: session.user_id, email: session.email, name: session.name };

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

    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

export async function requireStaffAuth(req, res, next) {
  try {
    let sessionId = req.cookies.staffSessionId;
    let fromCookie = true;
    if (!sessionId && req.headers.authorization) {
      sessionId = req.headers.authorization.replace('Bearer ', '');
      fromCookie = false;
    }

    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      return res.status(401).json({ error: 'No valid staff session provided' });
    }

    const session = await getStaffSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired staff session' });
    }

    if (!fromCookie && sessionId) {
      res.cookie('staffSessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
    }

    req.staffId = session.staff_id;
    req.staff = {
      id: session.staff_id,
      name: session.name,
      email: session.email,
      role: session.role,
      companyUserId: session.company_user_id,
      companyName: session.company_name
    };

    next();
  } catch (error) {
    console.error('Staff auth error:', error);
    res.status(401).json({ error: 'Staff authentication failed' });
  }
}

export async function authenticateStaffOrUser(req, res) {
  let sessionId = req.cookies.staffSessionId;
  if (!sessionId && req.headers.authorization) {
    sessionId = req.headers.authorization.replace('Bearer ', '');
  }

  if (sessionId && sessionId !== 'undefined' && sessionId !== 'null') {
    const staffSession = await getStaffSession(sessionId);
    if (staffSession) {
      req.staffId = staffSession.staff_id;
      req.staff = {
        id: staffSession.staff_id,
        name: staffSession.name,
        email: staffSession.email,
        role: staffSession.role,
        companyUserId: staffSession.company_user_id,
        companyName: staffSession.company_name
      };
      const staffResult = await pool.query('SELECT user_id FROM staff WHERE id = $1', [staffSession.staff_id]);
      if (staffResult.rows.length > 0) {
        req.userId = staffResult.rows[0].user_id;
      }
      if (!req.cookies.staffSessionId && sessionId) {
        res.cookie('staffSessionId', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000
        });
      }
      return { isStaff: true, staffId: staffSession.staff_id };
    }
  }

  sessionId = req.cookies.sessionId;
  if (!sessionId && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer wak_')) {
      const { verifyApiKey } = await import('../api-security.js');
      const keyData = await verifyApiKey(authHeader.replace('Bearer ', ''));
      if (keyData) {
        req.userId = keyData.user_id;
        req.user = { id: keyData.user_id, email: keyData.email, name: keyData.name };
        req.apiKey = keyData;
        return { isStaff: false, isApiKey: true };
      }
    }
    sessionId = authHeader.replace('Bearer ', '');
  }

  if (sessionId && sessionId !== 'undefined' && sessionId !== 'null') {
    const userSession = await getSession(sessionId);
    if (userSession) {
      if (!req.apiKey) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken) {
          await logSecurityEvent('csrf_token_missing', {
            userId: userSession.user_id,
            ipAddress: req.ip,
            endpoint: req.path,
            requestMethod: req.method,
            severity: 'warning'
          });
          res.status(403).json({
            error: 'CSRF token required. Include X-CSRF-Token header. Get token from /api/auth/csrf-token endpoint.'
          });
          return null;
        }
        const expectedToken = crypto
          .createHash('sha256')
          .update(sessionId + (process.env.SESSION_SECRET || config.sessionSecret || 'change-this-secret-key-in-production'))
          .digest('hex');
        if (csrfToken !== expectedToken) {
          await logSecurityEvent('csrf_token_invalid', {
            userId: userSession.user_id,
            ipAddress: req.ip,
            endpoint: req.path,
            requestMethod: req.method,
            severity: 'warning'
          });
          res.status(403).json({ error: 'Invalid CSRF token' });
          return null;
        }
      }
      req.userId = userSession.user_id;
      req.user = { id: userSession.user_id, email: userSession.email, name: userSession.name };
      if (!req.cookies.sessionId && sessionId) {
        res.cookie('sessionId', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000
        });
      }
      return { isStaff: false };
    }
  }

  return null;
}
