import {
  verifyApiKey,
  isIpWhitelisted,
  checkRateLimit,
  verifyRequestSignature,
  getSigningKeyByHash,
  logSecurityEvent,
  generateRequestFingerprint,
  detectSuspiciousActivity,
} from '../lib/api-security.js';
import { getSession } from '../services/auth.js';
import crypto from 'crypto';
import { verifyBrowserSessionCsrf } from '../lib/csrfSession.js';

export async function requireApiKey(req, res, next) {
  try {
    const apiKey =
      req.headers['x-api-key'] ||
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
        severity: 'warning',
      });

      return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    if (keyData.allowed_ips && keyData.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      const isAllowed = keyData.allowed_ips.some((allowedIp) => {
        if (allowedIp.includes('/')) {
          return clientIp.startsWith(
            allowedIp.split('/')[0].substring(0, allowedIp.split('/')[0].lastIndexOf('.'))
          );
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
          severity: 'warning',
        });

        return res.status(403).json({ error: 'IP address not whitelisted for this API key' });
      }
    }

    if (keyData.allowed_endpoints && keyData.allowed_endpoints.length > 0) {
      const path = req.path;
      const isAllowed = keyData.allowed_endpoints.some((pattern) => {
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
          severity: 'warning',
        });

        return res.status(403).json({ error: 'Endpoint not allowed for this API key' });
      }
    }

    req.userId = keyData.user_id;
    req.user = {
      id: keyData.user_id,
      email: keyData.email,
      name: keyData.name,
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
        severity: 'warning',
      });

      return res.status(403).json({ error: 'IP address not whitelisted' });
    }

    next();
  } catch (error) {
    console.error('IP whitelist check error:', error);
    res.status(500).json({ error: 'IP validation error' });
  }
}

/** UUID v4 (session tokens, staff session ids). */
const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultRateLimitIdentifier(req) {
  const headerKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer wak_')
      ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim()
      : null);
  if (headerKey?.startsWith('wak_')) {
    const h = crypto.createHash('sha256').update(headerKey).digest('hex').slice(0, 32);
    return `ak:${h}`;
  }

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
  if (bearer && SESSION_UUID_RE.test(bearer)) {
    return `sess:${bearer}`;
  }

  const sid = req.cookies?.sessionId;
  if (sid && SESSION_UUID_RE.test(String(sid))) {
    return `sess:${sid}`;
  }

  const staffSid = req.cookies?.staffSessionId;
  if (staffSid && SESSION_UUID_RE.test(String(staffSid))) {
    return `staffsess:${staffSid}`;
  }

  return `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
}

function resolveRateLimitThresholds(options) {
  const { limitPerMinute = 100, limitPerHour = 5000 } = options;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return {
      perMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || String(limitPerMinute), 10),
      perHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || String(limitPerHour), 10),
    };
  }
  return {
    perMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE_DEV || '2500', 10),
    perHour: parseInt(process.env.RATE_LIMIT_PER_HOUR_DEV || '50000', 10),
  };
}

/** Many 401/403s from one IP in a short window — possible credential stuffing or token scan. */
const authFailureByIp = new Map();

export function trackAuthFailureBursts(req, res, next) {
  res.on('finish', () => {
    const code = res.statusCode;
    if (code !== 401 && code !== 403) return;

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60_000;
    let row = authFailureByIp.get(ip);
    if (!row || now > row.expires) {
      row = { count: 0, expires: now + windowMs, logged: false };
      authFailureByIp.set(ip, row);
    }
    row.count += 1;

    const threshold = parseInt(process.env.AUTH_FAILURE_BURST_THRESHOLD || '40', 10);
    if (row.count >= threshold && !row.logged) {
      row.logged = true;
      logSecurityEvent('auth_failure_burst', {
        ipAddress: ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: { failuresInWindow: row.count, windowMs },
        severity: 'warning',
      }).catch(() => {});
    }

    if (authFailureByIp.size > 5000) {
      for (const [k, v] of authFailureByIp) {
        if (now > v.expires) authFailureByIp.delete(k);
      }
    }
  });
  next();
}

export function createRateLimiter(options = {}) {
  const { identifierFn = null } = options;

  return async (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      return next();
    }

    try {
      const { perMinute: basePerMinute, perHour: basePerHour } =
        resolveRateLimitThresholds(options);

      let identifier;
      if (typeof identifierFn === 'function') {
        identifier = identifierFn(req);
      } else if (req.apiKey?.api_key_hash) {
        identifier = `api_key:${req.apiKey.api_key_hash}`;
      } else if (req.userId) {
        identifier = `user:${req.userId}`;
      } else {
        identifier = defaultRateLimitIdentifier(req);
      }

      const perMinute = req.apiKey?.rate_limit_per_minute ?? basePerMinute;
      const perHour = req.apiKey?.rate_limit_per_hour ?? basePerHour;

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
            resetAt: rateLimitResult.resetAt,
          },
          severity: 'warning',
        });

        res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.floor(rateLimitResult.resetAt.getTime() / 1000));

        return res.status(429).json({
          error: 'Rate limit exceeded',
          limit: rateLimitResult.limit,
          resetAt: rateLimitResult.resetAt,
        });
      }

      res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
      res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(rateLimitResult.resetAt.getTime() / 1000));

      next();
    } catch (error) {
      console.error('Rate limit check error:', error);
      await logSecurityEvent('rate_limit_error', {
        userId: req.userId || null,
        ipAddress: req.ip,
        endpoint: req.path,
        details: { error: error.message },
        severity: 'error',
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
        error:
          'Request signing required. Missing X-Signature, X-Timestamp, or X-Signing-Key-Id headers',
      });
    }

    const signingKeyData = await getSigningKeyByHash(signingKeyId);

    if (!signingKeyData) {
      await logSecurityEvent('signing_key_invalid', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning',
      });

      return res.status(401).json({ error: 'Invalid signing key' });
    }

    const body = req.body || {};
    const method = req.method;
    const path =
      req.path +
      (req.query && Object.keys(req.query).length > 0
        ? '?' + new URLSearchParams(req.query).toString()
        : '');

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
        severity: 'warning',
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
          count: suspicious.count,
        },
        severity: 'error',
      });

    }

    next();
  } catch (error) {
    console.error('Fingerprinting error:', error);
    next(); // Don't block on fingerprinting errors
  }
}

export async function requireApiKeyOnly(req, res, next) {
  try {
    const apiKey =
      req.headers['x-api-key'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.replace('Bearer ', '')
        : null);

    if (!apiKey) {
      return res.status(401).json({
        error:
          'API key required. Session tokens are not accepted for this endpoint. Please use an API key.',
      });
    }

    if (!apiKey.startsWith('wak_')) {
      if (
        apiKey.length === 36 &&
        apiKey.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      ) {
        await logSecurityEvent('session_token_misused_as_api_key', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.path,
          requestMethod: req.method,
          details: {
            message: 'Session token used in API key context',
            tokenPrefix: apiKey.substring(0, 8),
          },
          severity: 'warning',
        });
      }

      return res.status(401).json({
        error:
          'Invalid API key format. API keys must start with "wak_". Session tokens are not accepted for programmatic access.',
      });
    }

    const keyData = await verifyApiKey(apiKey);

    if (!keyData) {
      await logSecurityEvent('api_key_invalid', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning',
      });

      return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    if (keyData.allowed_ips && keyData.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      const isAllowed = keyData.allowed_ips.some((allowedIp) => {
        if (allowedIp.includes('/')) {
          return clientIp.startsWith(
            allowedIp.split('/')[0].substring(0, allowedIp.split('/')[0].lastIndexOf('.'))
          );
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
          severity: 'warning',
        });

        return res.status(403).json({ error: 'IP address not whitelisted for this API key' });
      }
    }

    if (keyData.allowed_endpoints && keyData.allowed_endpoints.length > 0) {
      const path = req.path;
      const isAllowed = keyData.allowed_endpoints.some((pattern) => {
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
          severity: 'warning',
        });

        return res.status(403).json({ error: 'Endpoint not allowed for this API key' });
      }
    }

    req.userId = keyData.user_id;
    req.user = {
      id: keyData.user_id,
      email: keyData.email,
      name: keyData.name,
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
    if (req.apiKey) {
      return next();
    }

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

    const csrfOk = await verifyBrowserSessionCsrf(req, res, sessionId, session.user_id);
    if (!csrfOk) return;

    next();
  } catch (error) {
    console.error('CSRF check error:', error);
    res.status(500).json({ error: 'CSRF validation error' });
  }
}

export async function detectSessionTokenMisuse(req, res, next) {
  try {
    if (req.apiKey) {
      return next();
    }

    if (req.headers.authorization) {
      const token = req.headers.authorization.replace('Bearer ', '');

      if (
        token.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) &&
        !req.cookies.sessionId
      ) {
        await logSecurityEvent('session_token_in_authorization_header', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.path,
          requestMethod: req.method,
          details: {
            message:
              'Session token used in Authorization header. Consider using API key for programmatic access.',
            tokenPrefix: token.substring(0, 8),
          },
          severity: 'info',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Session token misuse detection error:', error);
    next();
  }
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.stripe.com;"
  );

  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
}

export function requireSecureApi(options = {}) {
  const {
    requireApiKey: needsApiKey = true,
    requireApiKeyOnly: apiKeyOnly = false,
    requireIpWhitelist = false,
    requireSignedRequest = false,
    requireCsrf = false,
    rateLimit = true,
    rateLimitOptions = {},
  } = options;

  return [
    securityHeaders,
    requestFingerprinting,
    detectSessionTokenMisuse,
    ...(needsApiKey ? (apiKeyOnly ? [requireApiKeyOnly] : [requireApiKey]) : []),
    ...(requireIpWhitelist ? [requireWhitelistedIp] : []),
    ...(requireSignedRequest ? [requireSignedRequest] : []),
    ...(requireCsrf ? [requireCsrfToken] : []),
    ...(rateLimit ? [createRateLimiter(rateLimitOptions)] : []),
  ];
}
