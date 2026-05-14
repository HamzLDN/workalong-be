import { pool } from '../lib/db.js';
import { getSession } from '../services/auth.js';
import { getStaffSession } from '../services/staff-auth.js';
import { logSecurityEvent } from '../lib/api-security.js';
import { verifyBrowserSessionCsrf } from '../lib/csrfSession.js';

async function authenticateUserRequest(req, res, { requireCsrf = true } = {}) {
  if (req.userId && req.apiKey) {
    return { ok: true };
  }

  const oneday = 1 * 24 * 60 * 60 * 1000;
  const apiKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer wak_')
      ? req.headers.authorization.replace('Bearer ', '')
      : null);

  if (apiKey && apiKey.startsWith('wak_')) {
    const { verifyApiKey } = await import('../lib/api-security.js');
    const keyData = await verifyApiKey(apiKey);
    if (keyData) {
      req.userId = keyData.user_id;
      req.user = { id: keyData.user_id, email: keyData.email, name: keyData.name };
      req.apiKey = keyData;
      return { ok: true };
    }
    res.status(401).json({ error: 'Invalid or expired API key' });
    return { ok: false };
  }

  let sessionId = req.cookies.sessionId;
  let fromCookie = true;
  if (!sessionId && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    sessionId = authHeader.replace('Bearer ', '');
    fromCookie = false;
    if (
      sessionId &&
      sessionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    ) {
      logSecurityEvent('session_token_in_authorization_header', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        endpoint: req.path,
        requestMethod: req.method,
        details: {
          message: 'Session token used in Authorization header.',
          tokenPrefix: sessionId.substring(0, 8),
        },
        severity: 'info',
      }).catch((err) => console.error('Failed to log security event:', err));
    }
  }

  if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
    res.status(401).json({ error: 'No valid session provided' });
    return { ok: false };
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return { ok: false };
  }

  if (!fromCookie && sessionId) {
    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: oneday * 7,
    });
  }

  req.userId = session.user_id;
  req.user = { id: session.user_id, email: session.email, name: session.name };

  if (!requireCsrf) {
    return { ok: true };
  }

  const csrfOk = await verifyBrowserSessionCsrf(req, res, sessionId, session.user_id);
  if (!csrfOk) {
    return { ok: false };
  }

  return { ok: true };
}

export async function requireAuth(req, res, next) {
  try {
    const result = await authenticateUserRequest(req, res, { requireCsrf: true });
    if (!result.ok) return;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

export async function requireAuthCompat(req, res, next) {
  try {
    const result = await authenticateUserRequest(req, res, { requireCsrf: false });
    if (!result.ok) return;
    next();
  } catch (error) {
    console.error('Compat auth error:', error);
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
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    }

    req.staffId = session.staff_id;
    req.staff = {
      id: session.staff_id,
      name: session.name,
      email: session.email,
      role: session.role,
      accessRole: session.access_role || 'employee',
      companyUserId: session.company_user_id,
      companyName: session.company_name,
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
        accessRole: staffSession.access_role || 'employee',
        companyUserId: staffSession.company_user_id,
        companyName: staffSession.company_name,
      };
      const staffResult = await pool.query('SELECT user_id FROM staff WHERE id = $1', [
        staffSession.staff_id,
      ]);
      if (staffResult.rows.length > 0) {
        req.userId = staffResult.rows[0].user_id;
      }
      if (!req.cookies.staffSessionId && sessionId) {
        res.cookie('staffSessionId', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
      }
      return { isStaff: true, staffId: staffSession.staff_id };
    }
  }

  sessionId = req.cookies.sessionId;
  if (!sessionId && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer wak_')) {
      const { verifyApiKey } = await import('../lib/api-security.js');
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
        const csrfOk = await verifyBrowserSessionCsrf(req, res, sessionId, userSession.user_id);
        if (!csrfOk) {
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
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
      }
      return { isStaff: false };
    }
  }

  return null;
}

/**
 * When the browser has both employer (`sessionId`) and staff (`staffSessionId`) cookies, the default
 * {@link authenticateStaffOrUser} chooses staff first — so the employer Schedule page hits staff
 * permission checks (e.g. schedule.read defaults false) and returns 403 even though the user is
 * viewing head-office UI. This variant validates employer session cookies / Bearer user sessions
 * first, then delegates to {@link authenticateStaffOrUser} for staff-only contexts.
 */
export async function authenticateStaffOrUserPreferEmployer(req, res) {
  if (req.cookies.sessionId && req.cookies.sessionId !== 'undefined' && req.cookies.sessionId !== 'null') {
    const userSession = await getSession(req.cookies.sessionId);
    if (userSession) {
      const csrfOk = await verifyBrowserSessionCsrf(
        req,
        res,
        req.cookies.sessionId,
        userSession.user_id
      );
      if (!csrfOk) return null;
      req.userId = userSession.user_id;
      req.user = { id: userSession.user_id, email: userSession.email, name: userSession.name };
      return { isStaff: false };
    }
  }

  if (req.headers.authorization?.startsWith('Bearer ')) {
    const authHeader = req.headers.authorization;
    if (!authHeader.includes('wak_')) {
      const token = authHeader.replace('Bearer ', '').trim();
      const userSession = await getSession(token);
      if (userSession) {
        const csrfOk = await verifyBrowserSessionCsrf(req, res, token, userSession.user_id);
        if (!csrfOk) return null;
        req.userId = userSession.user_id;
        req.user = { id: userSession.user_id, email: userSession.email, name: userSession.name };
        if (!req.cookies.sessionId) {
          res.cookie('sessionId', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
          });
        }
        return { isStaff: false };
      }
    }
  }

  return authenticateStaffOrUser(req, res);
}
