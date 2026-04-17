import crypto from 'crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { logSecurityEvent } from './api-security.js';

function sessionSecret() {
  return (
    process.env.SESSION_SECRET || config.sessionSecret || 'change-this-secret-key-in-production'
  );
}

/** Legacy deterministic token (before per-session stored tokens). Honoured once when sessions.csrf_token IS NULL. */
export function legacyDeterministicCsrfToken(sessionId) {
  return crypto
    .createHash('sha256')
    .update(sessionId + sessionSecret())
    .digest('hex');
}

export function generateStoredCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Current CSRF value for GET /auth/csrf-token (does not consume or rotate).
 * @returns {Promise<string|null>}
 */
export async function ensureSessionCsrfToken(sessionId) {
  const row = await pool.query(
    'SELECT csrf_token FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  if (row.rows.length === 0) return null;
  let token = row.rows[0].csrf_token;
  if (token) return token;

  const newToken = generateStoredCsrfToken();
  const up = await pool.query(
    `UPDATE sessions SET csrf_token = $1 WHERE id = $2 AND csrf_token IS NULL AND expires_at > NOW() RETURNING csrf_token`,
    [newToken, sessionId]
  );
  if (up.rows.length > 0) return up.rows[0].csrf_token;
  const again = await pool.query(
    'SELECT csrf_token FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  return again.rows[0]?.csrf_token || null;
}

/**
 * Validates the presented token and atomically rotates to a new one.
 * @returns {Promise<{ ok: true, newToken: string } | { ok: false, reason: string }>}
 */
export async function validateAndRotateSessionCsrf(sessionId, presentedToken) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    return { ok: false, reason: 'missing' };
  }

  const newToken = generateStoredCsrfToken();
  const r = await pool.query(
    `UPDATE sessions SET csrf_token = $1
     WHERE id = $2 AND csrf_token = $3 AND expires_at > NOW()
     RETURNING id`,
    [newToken, sessionId, presentedToken]
  );
  if (r.rowCount > 0) {
    return { ok: true, newToken };
  }

  const legacy = legacyDeterministicCsrfToken(sessionId);
  if (presentedToken !== legacy) {
    return { ok: false, reason: 'invalid' };
  }

  const r2 = await pool.query(
    `UPDATE sessions SET csrf_token = $1
     WHERE id = $2 AND csrf_token IS NULL AND expires_at > NOW()
     RETURNING id`,
    [newToken, sessionId]
  );
  if (r2.rowCount > 0) {
    return { ok: true, newToken };
  }

  return { ok: false, reason: 'invalid' };
}

/**
 * Validates token matches DB without rotating (for GET/HEAD/OPTIONS).
 * Parallel safe reads can share the same token; rotation on every GET would race and 403 the second request.
 * @returns {Promise<{ ok: true, tokenForHeader: string } | { ok: false, reason: string }>}
 */
export async function validateSessionCsrfWithoutRotation(sessionId, presentedToken) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    return { ok: false, reason: 'missing' };
  }

  const row = await pool.query(
    'SELECT csrf_token FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  if (row.rows.length === 0) {
    return { ok: false, reason: 'session' };
  }

  const stored = row.rows[0].csrf_token;
  if (stored && stored === presentedToken) {
    return { ok: true, tokenForHeader: stored };
  }

  const legacy = legacyDeterministicCsrfToken(sessionId);
  if (presentedToken === legacy) {
    return { ok: true, tokenForHeader: presentedToken };
  }

  return { ok: false, reason: 'invalid' };
}

/**
 * Validates CSRF for browser session requests.
 * Safe methods (GET/HEAD/OPTIONS): verify only — no rotation (avoids parallel load 403s).
 * Other methods: verify and rotate; new token in X-CSRF-Token.
 * @returns {Promise<boolean>} true if valid (response not yet sent); false if 403 sent
 */
export async function verifyBrowserSessionCsrf(req, res, sessionId, sessionUserId) {
  const csrfToken = req.headers['x-csrf-token'];
  if (!csrfToken) {
    await logSecurityEvent('csrf_token_missing', {
      userId: sessionUserId,
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      severity: 'warning',
    });
    res.status(403).json({
      error:
        'CSRF token required. Include X-CSRF-Token header. Get token from /api/auth/csrf-token endpoint.',
    });
    return false;
  }

  const method = (req.method || 'GET').toUpperCase();
  const isSafeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  if (isSafeMethod) {
    const readResult = await validateSessionCsrfWithoutRotation(sessionId, csrfToken);
    if (!readResult.ok) {
      await logSecurityEvent('csrf_token_invalid', {
        userId: sessionUserId,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning',
      });
      res.status(403).json({ error: 'Invalid CSRF token' });
      return false;
    }
    res.setHeader('X-CSRF-Token', readResult.tokenForHeader);
    return true;
  }

  const result = await validateAndRotateSessionCsrf(sessionId, csrfToken);
  if (!result.ok) {
    await logSecurityEvent('csrf_token_invalid', {
      userId: sessionUserId,
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      severity: 'warning',
    });
    res.status(403).json({ error: 'Invalid CSRF token' });
    return false;
  }

  res.setHeader('X-CSRF-Token', result.newToken);
  return true;
}
