import { 
  verifyApiKey, 
  isIpWhitelisted, 
  checkRateLimit, 
  verifyRequestSignature,
  getSigningKeyByHash,
  logSecurityEvent,
  generateRequestFingerprint,
  detectSuspiciousActivity
} from '../api-security.js';
import { getSession } from '../auth.js';
import crypto from 'crypto';

export async function requireApiKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'] || 
                   (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                     ? req.headers.authorization.replace('Bearer ', '') 
                     : null);
    
    if (!apiKey || !apiKey.startsWith('wak_')) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }
    
    const keyData = await verifyApiKey(apiKey);
    
    if (!keyData) {
      await logSecurityEvent('api_key_invalid', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }
    
    if (keyData.allowed_ips && keyData.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      const isAllowed = keyData.allowed_ips.some(allowedIp => {
        if (allowedIp.includes('/')) {
          return clientIp.startsWith(allowedIp.split('/')[0].substring(0, allowedIp.split('/')[0].lastIndexOf('.')));
        }
        return clientIp === allowedIp;
      });
      
      if (!isAllowed) {
        await logSecurityEvent('api_key_ip_blocked', {
          userId: keyData.user_id,
          ipAddress: clientIp,
          endpoint: req.path,
          requestMethod: req.method,
          details: { allowedIps: keyData.allowed_ips },
          severity: 'warning'
        });
        
        return res.status(403).json({ error: 'IP address not whitelisted for this API key' });
      }
    }

    if (keyData.allowed_endpoints && keyData.allowed_endpoints.length > 0) {
      const path = req.path;
      const isAllowed = keyData.allowed_endpoints.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(path);
      });
      
      if (!isAllowed) {
        await logSecurityEvent('api_key_endpoint_blocked', {
          userId: keyData.user_id,
          ipAddress: req.ip,
          endpoint: req.path,
          requestMethod: req.method,
          details: { allowedEndpoints: keyData.allowed_endpoints },
          severity: 'warning'
        });
        
        return res.status(403).json({ error: 'Endpoint not allowed for this API key' });
      }
    }
    
    // Set user context
    req.userId = keyData.user_id;
    req.user = {
      id: keyData.user_id,
      email: keyData.email,
      name: keyData.name
    };
    req.apiKey = keyData;
    
    next();
  } catch (error) {
    console.error('API key auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}


export async function requireWhitelistedIp(req, res, next) {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    const userId = req.userId || null;
    
    const isWhitelisted = await isIpWhitelisted(clientIp, userId);
    
    if (!isWhitelisted) {
      await logSecurityEvent('ip_blocked', {
        userId,
        ipAddress: clientIp,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(403).json({ error: 'IP address not whitelisted' });
    }
    
    next();
  } catch (error) {
    console.error('IP whitelist check error:', error);
    res.status(500).json({ error: 'IP validation error' });
  }
}


export function createRateLimiter(options = {}) {
  const {
    limitPerMinute = 60,
    limitPerHour = 1000,
    identifierFn = null // Custom function to get identifier
  } = options;
  
  return async (req, res, next) => {
    try {
      let identifier;
      
      if (identifierFn) {
        identifier = identifierFn(req);
      } else if (req.apiKey) {
        identifier = `api_key:${req.apiKey.api_key_hash}`;
      } else if (req.userId) {
        identifier = `user:${req.userId}`;
      } else {
        identifier = `ip:${req.ip || req.connection.remoteAddress}`;
      }
      
      // Use API key limits if available, otherwise use defaults
      const perMinute = req.apiKey?.rate_limit_per_minute || limitPerMinute;
      const perHour = req.apiKey?.rate_limit_per_hour || limitPerHour;
      
      const rateLimitResult = await checkRateLimit(identifier, req.path, perMinute, perHour);
      
      if (!rateLimitResult.allowed) {
        await logSecurityEvent('rate_limit_exceeded', {
          userId: req.userId || null,
          ipAddress: req.ip,
          endpoint: req.path,
          requestMethod: req.method,
          details: {
            identifier,
            limit: rateLimitResult.limit,
            resetAt: rateLimitResult.resetAt
          },
          severity: 'warning'
        });
        
        res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.floor(rateLimitResult.resetAt.getTime() / 1000));
        
        return res.status(429).json({ 
          error: 'Rate limit exceeded',
          limit: rateLimitResult.limit,
          resetAt: rateLimitResult.resetAt
        });
      }
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
      res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(rateLimitResult.resetAt.getTime() / 1000));
      
      next();
    } catch (error) {
      console.error('Rate limit check error:', error);
      // On error, allow request but log it
      await logSecurityEvent('rate_limit_error', {
        userId: req.userId || null,
        ipAddress: req.ip,
        endpoint: req.path,
        details: { error: error.message },
        severity: 'error'
      });
      next();
    }
  };
}


export async function requireSignedRequest(req, res, next) {
  try {
    const signature = req.headers['x-signature'];
    const timestamp = req.headers['x-timestamp'];
    const signingKeyId = req.headers['x-signing-key-id'];
    
    if (!signature || !timestamp || !signingKeyId) {
      return res.status(400).json({ 
        error: 'Request signing required. Missing X-Signature, X-Timestamp, or X-Signing-Key-Id headers' 
      });
    }
    
    // Get signing key
    const signingKeyData = await getSigningKeyByHash(signingKeyId);
    
    if (!signingKeyData) {
      await logSecurityEvent('signing_key_invalid', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(401).json({ error: 'Invalid signing key' });
    }
    
    // Verify signature
    const body = req.body || {};
    const method = req.method;
    const path = req.path + (req.query && Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '');
    
    // Note: In production, you'd need to store the actual signing key securely
    // For now, we'll use the hash as a placeholder - you'll need to implement
    // secure key storage (e.g., encrypted in database or key management service)
    const isValid = verifyRequestSignature(
      signingKeyData.signing_key_hash, // This should be the actual key, not hash
      method,
      path,
      body,
      timestamp,
      signature
    );
    
    if (!isValid) {
      await logSecurityEvent('request_signature_invalid', {
        userId: signingKeyData.user_id,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(401).json({ error: 'Invalid request signature' });
    }
    
    req.userId = signingKeyData.user_id;
    next();
  } catch (error) {
    console.error('Request signing verification error:', error);
    res.status(500).json({ error: 'Signature verification error' });
  }
}


export async function requestFingerprinting(req, res, next) {
  try {
    const fingerprint = generateRequestFingerprint(req);
    req.fingerprint = fingerprint;
    
    // Detect suspicious activity
    const suspicious = await detectSuspiciousActivity(
      fingerprint,
      req.ip || req.connection.remoteAddress,
      req.userId || null
    );
    
    if (suspicious.suspicious) {
      await logSecurityEvent('suspicious_activity_detected', {
        userId: req.userId || null,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        endpoint: req.path,
        requestMethod: req.method,
        details: {
          fingerprint,
          reason: suspicious.reason,
          count: suspicious.count
        },
        severity: 'error'
      });
      
      // Optionally block or rate limit more aggressively
      // For now, just log it
    }
    
    next();
  } catch (error) {
    console.error('Fingerprinting error:', error);
    next(); // Don't block on fingerprinting errors
  }
}


export async function requireApiKeyOnly(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'] || 
                   (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                     ? req.headers.authorization.replace('Bearer ', '') 
                     : null);
    
    if (!apiKey) {
      return res.status(401).json({ 
        error: 'API key required. Session tokens are not accepted for this endpoint. Please use an API key.' 
      });
    }
    
    if (!apiKey.startsWith('wak_')) {
      // Check if it's a session token being misused
      if (apiKey.length === 36 && apiKey.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        await logSecurityEvent('session_token_misused_as_api_key', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.path,
          requestMethod: req.method,
          details: { 
            message: 'Session token used in API key context',
            tokenPrefix: apiKey.substring(0, 8)
          },
          severity: 'warning'
        });
      }
      
      return res.status(401).json({ 
        error: 'Invalid API key format. API keys must start with "wak_". Session tokens are not accepted for programmatic access.' 
      });
    }
    
    const keyData = await verifyApiKey(apiKey);
    
    if (!keyData) {
      await logSecurityEvent('api_key_invalid', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }
    
    // Check IP whitelist if configured
    if (keyData.allowed_ips && keyData.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      const isAllowed = keyData.allowed_ips.some(allowedIp => {
        if (allowedIp.includes('/')) {
          return clientIp.startsWith(allowedIp.split('/')[0].substring(0, allowedIp.split('/')[0].lastIndexOf('.')));
        }
        return clientIp === allowedIp;
      });
      
      if (!isAllowed) {
        await logSecurityEvent('api_key_ip_blocked', {
          userId: keyData.user_id,
          ipAddress: clientIp,
          endpoint: req.path,
          requestMethod: req.method,
          details: { allowedIps: keyData.allowed_ips },
          severity: 'warning'
        });
        
        return res.status(403).json({ error: 'IP address not whitelisted for this API key' });
      }
    }

    if (keyData.allowed_endpoints && keyData.allowed_endpoints.length > 0) {
      const path = req.path;
      const isAllowed = keyData.allowed_endpoints.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(path);
      });
      
      if (!isAllowed) {
        await logSecurityEvent('api_key_endpoint_blocked', {
          userId: keyData.user_id,
          ipAddress: req.ip,
          endpoint: req.path,
          requestMethod: req.method,
          details: { allowedEndpoints: keyData.allowed_endpoints },
          severity: 'warning'
        });
        
        return res.status(403).json({ error: 'Endpoint not allowed for this API key' });
      }
    }
    
    // Set user context
    req.userId = keyData.user_id;
    req.user = {
      id: keyData.user_id,
      email: keyData.email,
      name: keyData.name
    };
    req.apiKey = keyData;
    
    next();
  } catch (error) {
    console.error('API key auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}


export async function requireCsrfToken(req, res, next) {
  try {
    // Skip CSRF for API keys (they don't need it)
    if (req.apiKey) {
      return next();
    }
    
    // Require CSRF for ALL methods when using session tokens
    // This prevents session token theft via XSS attacks
    
    // Get session to check CSRF token
    let sessionId = req.cookies.sessionId;
    if (!sessionId && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (!authHeader.startsWith('Bearer wak_')) {
        sessionId = authHeader.replace('Bearer ', '');
      }
    }
    
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required for CSRF protection' });
    }
    
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    
    // Get CSRF token from header
    const csrfToken = req.headers['x-csrf-token'];
    
    if (!csrfToken) {
      await logSecurityEvent('csrf_token_missing', {
        userId: session.user_id,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning'
      });
      
      return res.status(403).json({ error: 'CSRF token required. Include X-CSRF-Token header.' });
    }
    
    // Verify CSRF token matches session
    // For now, we'll generate it from session ID + secret
    // In production, store CSRF tokens in session or use a library
    const expectedToken = crypto
      .createHash('sha256')
      .update(sessionId + (process.env.SESSION_SECRET || 'change-this-secret-key-in-production'))
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
    console.error('CSRF check error:', error);
    res.status(500).json({ error: 'CSRF validation error' });
  }
}


export async function detectSessionTokenMisuse(req, res, next) {
  try {
    // Only check if not using API key
    if (req.apiKey) {
      return next();
    }
    
    // Check if Authorization header contains a session token (UUID format)
    if (req.headers.authorization) {
      const token = req.headers.authorization.replace('Bearer ', '');
      
      // Session tokens are UUIDs, API keys start with 'wak_'
      if (token.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) && 
          !req.cookies.sessionId) {
        // Session token in Authorization header without cookie - potential misuse
        await logSecurityEvent('session_token_in_authorization_header', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.path,
          requestMethod: req.method,
          details: { 
            message: 'Session token used in Authorization header. Consider using API key for programmatic access.',
            tokenPrefix: token.substring(0, 8)
          },
          severity: 'info'
        });
      }
    }
    
    next();
  } catch (error) {
    console.error('Session token misuse detection error:', error);
    next(); // Don't block on detection errors
  }
}


export function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Strict Transport Security (HTTPS only)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  // Content Security Policy (adjust based on your needs)
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.stripe.com;"
  );
  
  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions Policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  next();
}


export function requireSecureApi(options = {}) {
  const {
    requireApiKey: needsApiKey = true,
    requireApiKeyOnly: apiKeyOnly = false, // NEW: Force API key only, reject session tokens
    requireIpWhitelist = false,
    requireSignedRequest = false,
    requireCsrf = false, // NEW: Require CSRF for session-based requests
    rateLimit = true,
    rateLimitOptions = {}
  } = options;
  
  return [
    securityHeaders,
    requestFingerprinting,
    detectSessionTokenMisuse,
    ...(needsApiKey ? (apiKeyOnly ? [requireApiKeyOnly] : [requireApiKey]) : []),
    ...(requireIpWhitelist ? [requireWhitelistedIp] : []),
    ...(requireSignedRequest ? [requireSignedRequest] : []),
    ...(requireCsrf ? [requireCsrfToken] : []),
    ...(rateLimit ? [createRateLimiter(rateLimitOptions)] : [])
  ];
}
