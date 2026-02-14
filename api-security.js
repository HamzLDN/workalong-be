import crypto from 'crypto';
import { pool } from './db.js';
import { v4 as uuidv4 } from 'uuid';


export function generateApiKey() {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const apiKey = `wak_${randomBytes}`;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const prefix = apiKey.substring(0, 11);
  
  return { apiKey, hash, prefix };
}

export async function createApiKey(userId, keyName, options = {}) {
  const { apiKey, hash, prefix } = generateApiKey();
  
  const {
    expiresAt = null,
    allowedIps = [],
    allowedEndpoints = [],
    rateLimitPerMinute = 60,
    rateLimitPerHour = 1000
  } = options;
  
  const result = await pool.query(
    `INSERT INTO api_keys 
     (user_id, key_name, api_key_hash, api_key_prefix, expires_at, allowed_ips, allowed_endpoints, rate_limit_per_minute, rate_limit_per_hour)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, key_name, api_key_prefix, is_active, expires_at, allowed_ips, allowed_endpoints, rate_limit_per_minute, rate_limit_per_hour, created_at`,
    [userId, keyName, hash, prefix, expiresAt, allowedIps, allowedEndpoints, rateLimitPerMinute, rateLimitPerHour]
  );
  
  return {
    ...result.rows[0],
    apiKey
  };
}

export async function verifyApiKey(apiKey) {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  const result = await pool.query(
    `SELECT ak.*, u.id as user_id, u.email, u.name
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     WHERE ak.api_key_hash = $1 AND ak.is_active = TRUE
     AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
    [hash]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const keyData = result.rows[0];
  
  await pool.query(
    'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
    [keyData.id]
  );
  
  return keyData;
}

export async function getUserApiKeys(userId) {
  const result = await pool.query(
    `SELECT id, key_name, api_key_prefix, is_active, last_used_at, expires_at, 
            allowed_ips, allowed_endpoints, rate_limit_per_minute, rate_limit_per_hour, created_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  
  return result.rows;
}

export async function revokeApiKey(userId, keyId) {
  const result = await pool.query(
    'UPDATE api_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id',
    [keyId, userId]
  );
  
  return result.rows.length > 0;
}

export async function deleteApiKey(userId, keyId) {
  const result = await pool.query(
    'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
    [keyId, userId]
  );
  
  return result.rows.length > 0;
}


export async function isIpWhitelisted(ipAddress, userId = null) {
  const globalResult = await pool.query(
    `SELECT * FROM ip_whitelists 
     WHERE user_id IS NULL AND is_active = TRUE 
     AND (ip_address = $1 OR ($2 IS NOT NULL AND ip_address = $2))`,
    [ipAddress, ipAddress.split('/')[0]]
  );
  
  if (globalResult.rows.length > 0) {
    return true;
  }
  
  if (userId) {
    const userResult = await pool.query(
      `SELECT * FROM ip_whitelists 
       WHERE user_id = $1 AND is_active = TRUE 
       AND (ip_address = $2 OR ($3 IS NOT NULL AND ip_address = $3))`,
      [userId, ipAddress, ipAddress.split('/')[0]]
    );
    
    if (userResult.rows.length > 0) {
      return true;
    }
  }
  
  return false;
}

export async function addIpToWhitelist(userId, ipAddress, description = null) {
  const result = await pool.query(
    `INSERT INTO ip_whitelists (user_id, ip_address, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ip_address) 
     DO UPDATE SET is_active = TRUE, description = $3
     RETURNING *`,
    [userId, ipAddress, description]
  );
  
  return result.rows[0];
}

export async function removeIpFromWhitelist(userId, ipAddress) {
  const result = await pool.query(
    'UPDATE ip_whitelists SET is_active = FALSE WHERE user_id = $1 AND ip_address = $2 RETURNING *',
    [userId, ipAddress]
  );
  
  return result.rows.length > 0;
}

export async function getUserWhitelistedIps(userId) {
  const result = await pool.query(
    `SELECT * FROM ip_whitelists 
     WHERE user_id = $1 OR user_id IS NULL
     ORDER BY user_id NULLS LAST, created_at DESC`,
    [userId]
  );
  
  return result.rows;
}


export async function checkRateLimit(identifier, endpoint, limitPerMinute, limitPerHour) {
  const now = new Date();
  const minuteWindow = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const hourWindow = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  
  // Check minute limit
  const minuteResult = await pool.query(
    `SELECT request_count FROM rate_limit_logs
     WHERE identifier = $1 AND endpoint = $2 
     AND window_start = $3 AND window_type = 'minute'`,
    [identifier, endpoint, minuteWindow]
  );
  
  let minuteCount = 0;
  if (minuteResult.rows.length > 0) {
    minuteCount = minuteResult.rows[0].request_count;
  }
  
  if (minuteCount >= limitPerMinute) {
    return { allowed: false, limit: limitPerMinute, remaining: 0, resetAt: new Date(minuteWindow.getTime() + 60000) };
  }
  
  // Check hour limit
  const hourResult = await pool.query(
    `SELECT request_count FROM rate_limit_logs
     WHERE identifier = $1 AND endpoint = $2 
     AND window_start = $3 AND window_type = 'hour'`,
    [identifier, endpoint, hourWindow]
  );
  
  let hourCount = 0;
  if (hourResult.rows.length > 0) {
    hourCount = hourResult.rows[0].request_count;
  }
  
  if (hourCount >= limitPerHour) {
    return { allowed: false, limit: limitPerHour, remaining: 0, resetAt: new Date(hourWindow.getTime() + 3600000) };
  }
  
  // Update counters
  await pool.query(
    `INSERT INTO rate_limit_logs (identifier, endpoint, request_count, window_start, window_type)
     VALUES ($1, $2, 1, $3, 'minute')
     ON CONFLICT (identifier, endpoint, window_start, window_type)
     DO UPDATE SET request_count = rate_limit_logs.request_count + 1`,
    [identifier, endpoint, minuteWindow]
  );
  
  await pool.query(
    `INSERT INTO rate_limit_logs (identifier, endpoint, request_count, window_start, window_type)
     VALUES ($1, $2, 1, $3, 'hour')
     ON CONFLICT (identifier, endpoint, window_start, window_type)
     DO UPDATE SET request_count = rate_limit_logs.request_count + 1`,
    [identifier, endpoint, hourWindow]
  );
  
  return {
    allowed: true,
    limit: limitPerMinute,
    remaining: limitPerMinute - minuteCount - 1,
    resetAt: new Date(minuteWindow.getTime() + 60000)
  };
}


export function generateSigningKey() {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const signingKey = `wsk_${randomBytes}`;
  const hash = crypto.createHash('sha256').update(signingKey).digest('hex');
  const prefix = signingKey.substring(0, 11);
  
  return { signingKey, hash, prefix };
}

export async function createSigningKey(userId, keyName, expiresAt = null) {
  const { signingKey, hash, prefix } = generateSigningKey();
  
  const result = await pool.query(
    `INSERT INTO request_signing_keys 
     (user_id, key_name, signing_key_hash, signing_key_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, key_name, signing_key_prefix, is_active, expires_at, created_at`,
    [userId, keyName, hash, prefix, expiresAt]
  );
  
  return {
    ...result.rows[0],
    signingKey // Only returned on creation
  };
}

export function verifyRequestSignature(signingKey, method, path, body, timestamp, signature) {
  // Prevent replay attacks (timestamp must be within 5 minutes)
  const requestTime = parseInt(timestamp, 10);
  const now = Date.now();
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return false;
  }
  
  // Create signature payload
  const payload = `${method}\n${path}\n${timestamp}\n${JSON.stringify(body)}`;
  const expectedSignature = crypto
    .createHmac('sha256', signingKey)
    .update(payload)
    .digest('hex');
  
  // Use constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

export async function getSigningKeyByHash(hash) {
  const result = await pool.query(
    `SELECT * FROM request_signing_keys
     WHERE signing_key_hash = $1 AND is_active = TRUE
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  // Update last_used_at
  await pool.query(
    'UPDATE request_signing_keys SET last_used_at = NOW() WHERE id = $1',
    [result.rows[0].id]
  );
  
  return result.rows[0];
}


export async function logSecurityEvent(eventType, options = {}) {
  try {
    const {
      userId = null,
      ipAddress = null,
      userAgent = null,
      endpoint = null,
      requestMethod = null,
      details = {},
      severity = 'info'
    } = options;
    
    await pool.query(
      `INSERT INTO security_audit_logs 
       (user_id, event_type, ip_address, user_agent, endpoint, request_method, details, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, eventType, ipAddress, userAgent, endpoint, requestMethod, JSON.stringify(details), severity]
    );
  } catch (error) {
    // Gracefully handle missing table (migration not run yet)
    if (error.code === '42P01') {
      // Table doesn't exist - just log to console for now
      console.log(`[Security Event] ${eventType}:`, {
        userId,
        ipAddress,
        endpoint,
        severity,
        details
      });
      return;
    }
    // For other errors, log but don't throw
    console.error('Failed to log security event:', error.message);
  }
}

export async function getSecurityAuditLogs(userId = null, limit = 100) {
  let query = `SELECT * FROM security_audit_logs`;
  const params = [];
  
  if (userId) {
    query += ' WHERE user_id = $1';
    params.push(userId);
  }
  
  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  
  const result = await pool.query(query, params);
  return result.rows;
}


export function generateRequestFingerprint(req) {
  const components = [
    req.ip || req.connection.remoteAddress,
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || ''
  ];
  
  return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}

export async function detectSuspiciousActivity(fingerprint, ipAddress, userId = null) {
  // Check for rapid requests from same fingerprint
  const recentRequests = await pool.query(
    `SELECT COUNT(*) as count FROM security_audit_logs
     WHERE (ip_address = $1 OR details->>'fingerprint' = $2)
     AND created_at > NOW() - INTERVAL '1 minute'`,
    [ipAddress, fingerprint]
  );
  
  const requestCount = parseInt(recentRequests.rows[0].count, 10);
  
  if (requestCount > 30) {
    return {
      suspicious: true,
      reason: 'rapid_requests',
      count: requestCount
    };
  }
  
  return { suspicious: false };
}
