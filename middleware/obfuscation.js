import crypto from 'crypto';
import { getSession } from '../services/auth.js';
import { logSecurityEvent } from '../lib/api-security.js';
import {
  TRANSPORT_CLIENT_ACTIVE_HEADER,
  TRANSPORT_CLIENT_ACTIVE_VALUE,
} from '../lib/transportClientHeader.js';

export { TRANSPORT_CLIENT_ACTIVE_HEADER, TRANSPORT_CLIENT_ACTIVE_VALUE };

/** When NODE_ENV=dev and DISABLE_OBFUSCATION=true (see npm run dev), skip XOR + signed transport for easier debugging. */
function isDevPlainApi() {
  return process.env.NODE_ENV === 'dev' && process.env.DISABLE_OBFUSCATION === 'true';
}

function isClientTransportActive(req) {
  const h = req.headers;
  return h[TRANSPORT_CLIENT_ACTIVE_HEADER] === TRANSPORT_CLIENT_ACTIVE_VALUE;
}

/** @param {number} [referenceMs] Wall time used for the rotating minute bucket (defaults to now). Must match the request's X-Request-Timestamp when verifying or replaying. */
function generateObfuscationKey(sessionId, referenceMs = Date.now()) {
  if (!sessionId) {
    throw new Error('Session required for API obfuscation');
  }
  const ms =
    typeof referenceMs === 'number' && Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const timeComponent = Math.floor(ms / 60000);
  return `${sessionId}_${timeComponent}`.substring(0, 32);
}

function deobfuscateData(obfuscated, key) {
  try {
    const dataArray = new Uint8Array(Buffer.from(obfuscated, 'base64'));
    const keyArray = Buffer.from(key, 'utf8');
    const result = new Uint8Array(dataArray.length);

    for (let i = 0; i < dataArray.length; i++) {
      result[i] = dataArray[i] ^ keyArray[i % keyArray.length];
    }

    return Buffer.from(result).toString('utf8');
  } catch (error) {
    throw new Error('Failed to deobfuscate data');
  }
}

function obfuscateData(data, key) {
  const dataArray = Buffer.from(data, 'utf8');
  const keyArray = Buffer.from(key, 'utf8');
  const result = new Uint8Array(dataArray.length);

  for (let i = 0; i < dataArray.length; i++) {
    result[i] = dataArray[i] ^ keyArray[i % keyArray.length];
  }

  return Buffer.from(result).toString('base64');
}

function generateRequestSignature(method, url, body, sessionId, timestamp, nonce) {
  const refMs = Number(timestamp);
  const key = generateObfuscationKey(sessionId, Number.isFinite(refMs) ? refMs : Date.now());
  const payload = `${method}:${url}:${body || ''}:${timestamp}:${nonce}`;

  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const char = payload.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const combined = `${hash}:${key}`;
  let finalHash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    finalHash = (finalHash << 5) - finalHash + char;
    finalHash = finalHash & finalHash;
  }

  return Math.abs(finalHash).toString(36);
}

function verifyRequestSignature(method, endpoint, body, sessionId, timestamp, nonce, signature) {
  const expectedSignature = generateRequestSignature(
    method,
    endpoint,
    body || '',
    sessionId,
    timestamp,
    nonce
  );

  return expectedSignature === signature;
}

/**
 * Validates signed-transport headers against the request body (before body deobfuscation).
 * Used in dev plain API when the client still sends transport + signature headers.
 * @returns {null | { status: number, body: object }}
 */
function verifySignedTransportHeaders(req, parsedBody) {
  let sessionId = req.cookies?.sessionId;
  if (!sessionId && req.headers.authorization?.startsWith('Bearer ')) {
    sessionId = req.headers.authorization.replace('Bearer ', '').trim();
  }
  if (!sessionId && req.headers['x-link-token'] && req.headers['x-device-fingerprint']) {
    sessionId = `clocklink:${req.headers['x-link-token']}:${req.headers['x-device-fingerprint']}`;
  }
  if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
    return { status: 401, body: { error: 'Session required for obfuscated requests' } };
  }

  const timestamp = req.headers['x-request-timestamp'];
  const nonce = req.headers['x-request-nonce'];
  const signature = req.headers['x-request-signature'];

  const requestTime = parseInt(timestamp, 10);
  const now = Date.now();
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return { status: 400, body: { error: 'Request timestamp too old or invalid' } };
  }

  let bodyString = '';
  if (parsedBody && typeof parsedBody === 'object') {
    if (
      parsedBody.format === 'information' &&
      Object.prototype.hasOwnProperty.call(parsedBody, 'data')
    ) {
      bodyString = parsedBody.data || '';
    } else {
      const keys = Object.keys(parsedBody);
      bodyString = keys.length === 0 ? '' : JSON.stringify(parsedBody);
    }
  } else if (parsedBody !== undefined && parsedBody !== null) {
    bodyString = String(parsedBody);
  }

  let endpointPath = req.path;
  if (endpointPath.includes('?')) {
    endpointPath = endpointPath.split('?')[0];
  }
  if (!endpointPath.startsWith('/')) {
    endpointPath = '/' + endpointPath;
  }
  if (endpointPath.startsWith('/api/')) {
    endpointPath = endpointPath.substring(4);
  }

  const isValid = verifyRequestSignature(
    req.method,
    endpointPath,
    bodyString,
    sessionId,
    timestamp,
    nonce,
    signature
  );

  if (!isValid) {
    return { status: 401, body: { error: 'Invalid request signature' } };
  }
  return null;
}

function deobfuscateEndpoint(obfuscated) {
  try {
    const derotated = obfuscated
      .split('')
      .map((char, idx) => {
        const code = char.charCodeAt(0);
        if (code >= 65 && code <= 90) {
          return String.fromCharCode(((code - 65 - idx + 26) % 26) + 65);
        }
        if (code >= 97 && code <= 122) {
          return String.fromCharCode(((code - 97 - idx + 26) % 26) + 97);
        }
        return char;
      })
      .join('');

    return '/' + Buffer.from(derotated, 'base64').toString('utf8');
  } catch (error) {
    throw new Error('Invalid obfuscated endpoint');
  }
}

// List of public endpoints that don't require obfuscation
const PUBLIC_ENDPOINTS = [
  '/health',
  '/api/health',
  '/contact',
  '/api/contact',
  '/demo-booking',
  '/api/demo-booking',
  '/public/trial-period',
  '/api/public/trial-period',
  '/auth/public-csrf-token',
  '/api/auth/public-csrf-token',
  '/auth/signup',
  '/api/auth/signup',
  '/auth/signin',
  '/api/auth/signin',
  '/auth/forgot-password',
  '/api/auth/forgot-password',
  '/auth/reset-password',
  '/api/auth/reset-password',
  '/auth/verify-code',
  '/api/auth/verify-code',
  '/auth/csrf-token',
  '/api/auth/csrf-token',
  '/auth/session-id',
  '/api/auth/session-id',
  // '/activities',
  // '/api/activities',
  // '/activities/stats',
  // '/api/activities/stats',
  '/payment/webhook',
  '/api/payment/webhook',
  '/payment/config',
  '/api/payment/config',
  '/payment/verify-session',
  '/api/payment/verify-session',
  // Kiosk clocking flow (link-token + device-fingerprint based; no session)
  '/clockin/clock-action',
  '/api/clockin/clock-action',
];

const PUBLIC_ENDPOINT_PREFIXES = [
  '/clockin/verify-link/',
  '/api/clockin/verify-link/',
  '/clockin/status/',
  '/api/clockin/status/',
  // Support chat is served by admin-panel-api (port 5055). If a request hits this backend by mistake,
  // skip obfuscation so the request fails with a normal 404 instead of "transport required".
  '/api/support',
  '/support',
];

/** Exported for tests — public routes skip transport/signature (see verifyObfuscatedRequest). */
export function isPublicEndpoint(path) {
  if (path == null || path === '') return false;
  // Remove query string; strip trailing slashes (proxies and browsers may send /api/foo/)
  let cleanPath = path.split('?')[0];
  cleanPath = cleanPath.replace(/\/+$/, '') || '/';
  // Normalize path - handle both /api/activities and /activities
  let normalized = cleanPath;
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  // Strip /api prefix if present (backend may receive /api/activities or /activities depending on proxy)
  if (normalized.startsWith('/api/')) {
    normalized = '/' + normalized.substring(5); // /api/activities -> /activities
  }
  const isPublic =
    PUBLIC_ENDPOINTS.includes(normalized) ||
    PUBLIC_ENDPOINTS.includes(cleanPath) ||
    PUBLIC_ENDPOINTS.includes('/api' + normalized) ||
    PUBLIC_ENDPOINT_PREFIXES.some(
      (prefix) => cleanPath.startsWith(prefix) || normalized.startsWith(prefix)
    );
  return isPublic;
}

function hasRequestBody(req) {
  // Check if request has a body with data
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
    return false;
  }

  // Check content-type and body
  const contentType = req.headers['content-type'] || '';
  const hasBody = req.body && Object.keys(req.body).length > 0;
  const hasRawBody = req.body && typeof req.body === 'string' && req.body.length > 0;

  return (
    hasBody ||
    hasRawBody ||
    contentType.includes('application/json') ||
    contentType.includes('application/x-obfuscated')
  );
}

export async function verifyObfuscatedRequest(req, res, next) {
  try {
    if (isDevPlainApi()) {
      const rawBody = req.body;
      // Requests that opt into signed transport must still fail on bad signatures (security tests / prod-like clients).
      if (isClientTransportActive(req)) {
        const sig = req.headers['x-request-signature'];
        const ts = req.headers['x-request-timestamp'];
        const nonce = req.headers['x-request-nonce'];
        if (sig && ts && nonce) {
          const transportErr = verifySignedTransportHeaders(req, rawBody);
          if (transportErr) {
            return res.status(transportErr.status).json(transportErr.body);
          }
        }
      }
      // Skip signature/timestamp validation for plain JSON in dev, but still decode the body when the frontend
      // sent it in obfuscated format — otherwise req.body is the {data,format} wrapper and route
      // handlers can't find staffId, shiftDate etc.
      if (
        rawBody &&
        rawBody.format === 'information' &&
        Object.prototype.hasOwnProperty.call(rawBody, 'data')
      ) {
        let devSessionId = req.cookies?.sessionId;
        if (!devSessionId && req.headers.authorization?.startsWith('Bearer ')) {
          devSessionId = req.headers.authorization.replace('Bearer ', '').trim();
        }
        if (devSessionId && devSessionId !== 'undefined' && devSessionId !== 'null') {
          try {
            const devTs = req.headers['x-request-timestamp'];
            const devRefMs = devTs ? parseInt(devTs, 10) : Date.now();
            const devKey = generateObfuscationKey(
              devSessionId,
              Number.isFinite(devRefMs) ? devRefMs : Date.now()
            );
            req.body = rawBody.data === '' ? {} : JSON.parse(deobfuscateData(rawBody.data, devKey));
          } catch (_) {
            // If deobfuscation fails in dev, leave body as-is so the route returns a useful error
          }
        }
      }
      return next();
    }

    // Trusted internal service (e.g. workalong-ai): plain JSON, Docker network + shared secret.
    // Still requires user Authorization + CSRF; route handlers enforce access control.
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
    if (internalSecret && req.headers['x-workalong-internal-secret'] === internalSecret) {
      req.workalongInternalGateway = true;
      return next();
    }

    const transportActive = isClientTransportActive(req);
    const pathFromUrl = req.originalUrl ? req.originalUrl.split('?')[0] : '';
    const isPublic = isPublicEndpoint(req.path) || (pathFromUrl && isPublicEndpoint(pathFromUrl));

    // Public endpoints don't require obfuscation
    if (isPublic) {
      return next();
    }

    // All non-public endpoints require signed transport + XOR body when applicable
    if (!transportActive) {
      await logSecurityEvent('obfuscation_required', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: {
          hasBody: !!req.body,
          contentType: req.headers['content-type'],
          requestMethod: req.method,
        },
        severity: 'warning',
      });
      return res.status(400).json({
        error: 'Client protocol required',
        message: 'This endpoint must be called from a supported client.',
      });
    }

    let sessionId = req.cookies.sessionId;
    if (!sessionId && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        sessionId = authHeader.replace('Bearer ', '').trim();
      }
    }
    if (!sessionId && req.headers['x-link-token'] && req.headers['x-device-fingerprint']) {
      sessionId = `clocklink:${req.headers['x-link-token']}:${req.headers['x-device-fingerprint']}`;
    }

    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      await logSecurityEvent('obfuscation_no_session', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: {
          hasCookie: !!req.cookies.sessionId,
          hasAuthHeader: !!req.headers.authorization,
          authHeader: req.headers.authorization ? 'present' : 'missing',
        },
        severity: 'warning',
      });
      return res.status(401).json({ error: 'Session required for obfuscated requests' });
    }

    const timestamp = req.headers['x-request-timestamp'];
    const nonce = req.headers['x-request-nonce'];
    const signature = req.headers['x-request-signature'];

    if (!timestamp || !nonce || !signature) {
      await logSecurityEvent('obfuscation_missing_headers', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        severity: 'warning',
      });
      return res.status(400).json({ error: 'Missing obfuscation headers' });
    }

    const requestTime = parseInt(timestamp, 10);
    const now = Date.now();
    if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
      await logSecurityEvent('obfuscation_timestamp_invalid', {
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: { timestamp, now },
        severity: 'warning',
      });
      return res.status(400).json({ error: 'Request timestamp too old or invalid' });
    }

    let parsedBody = req.body;
    if (!parsedBody && req.headers['content-type'] === 'application/x-obfuscated') {
      try {
        if (typeof req.body === 'string') {
          parsedBody = JSON.parse(req.body);
        } else if (Buffer.isBuffer(req.body)) {
          parsedBody = JSON.parse(req.body.toString());
        }
      } catch (error) {
        parsedBody = {};
      }
    }

    let bodyString = '';

    if (parsedBody && typeof parsedBody === 'object') {
      // Check if it's the obfuscated format - data can be empty string, so check for property existence
      if (parsedBody.format === 'information' && parsedBody.hasOwnProperty('data')) {
        bodyString = parsedBody.data || ''; // Use empty string if data is empty
      } else {
        const keys = Object.keys(parsedBody);
        if (keys.length === 0) {
          bodyString = '';
        } else {
          bodyString = JSON.stringify(parsedBody);
        }
      }
    } else if (parsedBody !== undefined && parsedBody !== null) {
      bodyString = String(parsedBody);
    }

    let endpointPath = req.path;

    if (endpointPath.includes('?')) {
      endpointPath = endpointPath.split('?')[0];
    }

    if (!endpointPath.startsWith('/')) {
      endpointPath = '/' + endpointPath;
    }

    if (endpointPath.startsWith('/api/')) {
      endpointPath = endpointPath.substring(4);
    }

    const isValid = verifyRequestSignature(
      req.method,
      endpointPath,
      bodyString,
      sessionId,
      timestamp,
      nonce,
      signature
    );

    if (!isValid) {
      const expectedSignature = generateRequestSignature(
        req.method,
        endpointPath,
        bodyString,
        sessionId,
        timestamp,
        nonce
      );

      console.error('Signature verification failed:', {
        method: req.method,
        originalPath: req.path,
        normalizedPath: endpointPath,
        receivedSignature: signature,
        expectedSignature: expectedSignature,
        bodyLength: bodyString ? bodyString.length : 0,
        sessionIdPrefix: sessionId ? sessionId.substring(0, 8) : 'none',
      });

      await logSecurityEvent('obfuscation_signature_invalid', {
        ipAddress: req.ip,
        endpoint: req.path,
        normalizedEndpoint: endpointPath,
        requestMethod: req.method,
        details: {
          receivedSignature: signature,
          expectedSignature: expectedSignature,
          bodyType: typeof bodyString,
          bodyLength: bodyString ? bodyString.length : 0,
        },
        severity: 'warning',
      });
      return res.status(401).json({ error: 'Invalid request signature' });
    }

    if (parsedBody && parsedBody.format === 'information' && parsedBody.hasOwnProperty('data')) {
      try {
        const key = generateObfuscationKey(sessionId, requestTime);
        // Handle empty string data - if data is empty, body should be empty object
        if (parsedBody.data === '') {
          req.body = {};
        } else {
          const deobfuscated = deobfuscateData(parsedBody.data, key);
          req.body = JSON.parse(deobfuscated);
        }
      } catch (error) {
        await logSecurityEvent('obfuscation_deobfuscate_failed', {
          ipAddress: req.ip,
          endpoint: req.path,
          requestMethod: req.method,
          severity: 'error',
        });
        return res.status(400).json({ error: 'Failed to deobfuscate request body' });
      }
    } else if (parsedBody && typeof parsedBody === 'object') {
      req.body = parsedBody;
    }

    req.obfuscation = {
      enabled: true,
      sessionId,
      key: generateObfuscationKey(sessionId),
    };

    next();
  } catch (error) {
    console.error('Obfuscation verification error:', error);
    await logSecurityEvent('obfuscation_error', {
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      details: { error: error.message },
      severity: 'error',
    });
    res.status(500).json({ error: 'Obfuscation verification failed' });
  }
}

export function obfuscateResponse(req, res, next) {
  if (isDevPlainApi()) {
    return next();
  }

  if (req.workalongInternalGateway) {
    return next();
  }

  // Always obfuscate responses for authenticated endpoints with data
  const isPublic = isPublicEndpoint(req.path);
  const hasData = hasRequestBody(req);
  const transportRequested = isClientTransportActive(req);

  // Obfuscate if:
  // 1. Request was obfuscated (req.obfuscation exists)
  // 2. OR it's an authenticated endpoint with data (not public)
  const shouldObfuscate =
    (req.obfuscation && req.obfuscation.enabled) ||
    (transportRequested && !isPublic && hasData) ||
    (!isPublic && hasData && (req.userId || req.staffId));

  if (!shouldObfuscate) {
    return next();
  }

  // Get obfuscation key
  let obfuscationKey;
  if (req.obfuscation && req.obfuscation.key) {
    obfuscationKey = req.obfuscation.key;
  } else {
    // Generate key from session if available
    let sessionId = req.cookies?.sessionId || req.cookies?.staffSessionId;
    if (!sessionId && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        sessionId = authHeader.replace('Bearer ', '').trim();
      }
    }
    if (sessionId && sessionId !== 'undefined' && sessionId !== 'null') {
      obfuscationKey = generateObfuscationKey(sessionId);
      // Store in req.obfuscation for consistency
      if (!req.obfuscation) {
        req.obfuscation = { enabled: true, sessionId, key: obfuscationKey };
      }
    } else {
      // No session, can't obfuscate - but this shouldn't happen for authenticated endpoints
      return next();
    }
  }

  const originalJson = res.json.bind(res);

  res.json = function (data) {
    try {
      const obfuscated = obfuscateData(JSON.stringify(data), obfuscationKey);
      res.setHeader('Content-Type', 'application/json');
      return originalJson({
        format: 'information',
        data: obfuscated,
      });
    } catch (error) {
      console.error('Failed to obfuscate response:', error);
      return originalJson(data);
    }
  };

  next();
}

export async function requireSubscription(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (process.env.NODE_ENV === 'dev') {
      req.subscriptionPlan = 'trial';
      return next();
    }

    const subscriptionPlan = req.headers['x-subscription-plan'];

    // Verify subscription via Stripe API (source of truth)
    const { verifySubscriptionStatus } = await import('../services/stripe.js');
    const verification = await verifySubscriptionStatus(req.userId);

    if (!verification.isActive) {
      await logSecurityEvent('subscription_required', {
        userId: req.userId,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: { status: verification.status, message: verification.message },
        severity: 'info',
      });
      return res.status(403).json({
        error: 'Premium subscription required',
        currentPlan: verification.subscriptionPlan || 'free',
        requiredPlan: 'professional',
      });
    }

    if (subscriptionPlan && subscriptionPlan !== verification.subscriptionPlan) {
      await logSecurityEvent('subscription_header_mismatch', {
        userId: req.userId,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: { headerPlan: subscriptionPlan, verifiedPlan: verification.subscriptionPlan },
        severity: 'warning',
      });
    }

    req.subscriptionPlan = verification.subscriptionPlan || 'professional';
    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Subscription verification failed' });
  }
}
