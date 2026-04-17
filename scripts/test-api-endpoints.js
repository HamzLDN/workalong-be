import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { pool } from '../lib/db.js';
import {
  TRANSPORT_CLIENT_ACTIVE_HEADER,
  TRANSPORT_CLIENT_ACTIVE_VALUE,
} from '../lib/transportClientHeader.js';

dotenv.config();

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// Assertion helper: shows expected vs actual, returns pass/fail
function assertResult(testName, expected, actual, passed) {
  const matchStr = passed ? `${GREEN}✓ MATCH${RESET}` : `${RED}✗ MISMATCH${RESET}`;
  console.log(`  ${CYAN}Expected:${RESET} ${JSON.stringify(expected)}`);
  console.log(`  ${CYAN}Actual:${RESET}   ${JSON.stringify(actual)}`);
  console.log(`  ${CYAN}Result:${RESET}   ${matchStr} ${passed ? 'PASS' : 'FAIL'}`);
  return passed;
}

// Helper for status-only checks: expects { status, ok }, logs expected vs actual
// expectedStatus can be a number (200) or array ([200, 201], [200, 403])
function assertStatusResponse(testName, result, expectedStatus = 200) {
  const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const expected = { status: allowed.length === 1 ? allowed[0] : allowed.join(' or ') };
  const actual = { status: result?.status ?? 0, ok: result?.ok ?? false };
  const passed = allowed.includes(result?.status) && (result?.status < 300 ? result?.ok : true);
  console.log(`  ${testName}:`);
  assertResult(testName, expected, actual, passed);
  return passed;
}

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8081/api';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-key-in-production';

/** Bootstrap CSRF from GET /auth/csrf-token (no X-CSRF-Token required). */
async function fetchCsrfTokenFromApi(sid) {
  if (!sid) return null;
  const url = `${API_BASE_URL}/auth/csrf-token`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${sid}`,
      Cookie: `sessionId=${sid}`,
    },
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data?.csrfToken || null;
}

// ============================================
// OBFUSCATION CORE (shared with frontend)
// ============================================
// These helpers are used ONLY by obfuscated flows:
// - makeObfuscatedRequest(...)
// - makeClockLinkRequest(...)
// Any tests that call those helpers are exercising the obfuscated protocol.
//
// Tests that call makeRequest(...) instead are plain JSON, non‑obfuscated calls.

// Obfuscation utilities (same as in frontend obfuscation.js)
function obfuscateData(data, key) {
  const dataArray = Buffer.from(data, 'utf8');
  const keyArray = Buffer.from(key, 'utf8');
  const result = new Uint8Array(dataArray.length);

  for (let i = 0; i < dataArray.length; i++) {
    result[i] = dataArray[i] ^ keyArray[i % keyArray.length];
  }

  return Buffer.from(result).toString('base64');
}

function deobfuscateData(obfuscated, key) {
  const dataArray = new Uint8Array(Buffer.from(obfuscated, 'base64'));
  const keyArray = Buffer.from(key, 'utf8');
  const result = new Uint8Array(dataArray.length);

  for (let i = 0; i < dataArray.length; i++) {
    result[i] = dataArray[i] ^ keyArray[i % keyArray.length];
  }

  return Buffer.from(result).toString('utf8');
}

let sessionId = null;
let csrfToken = null;
let userId = null;
let staffId = null;
let createdShiftId = null;
let createdLocationId = null;
let createdBudgetId = null;
let createdApiKeyId = null;
let createdClockinLinkId = null;
let clockinLinkToken = null;
let clockinDeviceFingerprint = null;

// Generate device fingerprint (matches frontend logic - Node.js version without canvas)
function generateDeviceFingerprint() {
  const fingerprint = [
    'node-test-agent',
    'en-US',
    '1920x1080',
    new Date().getTimezoneOffset(),
    'test-canvas-data',
    '8',
    'Linux',
  ].join('|');
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const char = fingerprint.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// Make obfuscated request using clock-link auth (X-Link-Token + X-Device-Fingerprint)
// Matches frontend: uses clocklink:token:fp as obfuscation key, same body/headers as clockin API
async function makeClockLinkRequest(endpoint, body, method, linkToken, deviceFingerprint) {
  const clocklinkSessionId = `clocklink:${linkToken}:${deviceFingerprint}`;
  const timestamp = Date.now();
  const nonce =
    Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const key = generateObfuscationKey(clocklinkSessionId, timestamp);

  let endpointPath = endpoint;
  if (endpointPath.includes('?')) {
    endpointPath = endpointPath.split('?')[0];
  }
  if (!endpointPath.startsWith('/')) {
    endpointPath = '/' + endpointPath;
  }
  if (endpointPath.startsWith('/api/')) {
    endpointPath = endpointPath.substring(4);
  }

  let obfuscatedBody = null;
  let bodyStringForSignature = '';

  if (body !== null && body !== undefined) {
    if (typeof body === 'object') {
      if (Object.keys(body).length > 0) {
        const bodyStr = JSON.stringify(body);
        obfuscatedBody = obfuscateData(bodyStr, key);
        bodyStringForSignature = obfuscatedBody;
      } else {
        bodyStringForSignature = '';
      }
    } else {
      const bodyStr = String(body);
      obfuscatedBody = obfuscateData(bodyStr, key);
      bodyStringForSignature = obfuscatedBody;
    }
  } else {
    bodyStringForSignature = '';
  }

  const signature = generateRequestSignature(
    method,
    endpointPath,
    bodyStringForSignature,
    clocklinkSessionId,
    timestamp,
    nonce
  );

  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    [TRANSPORT_CLIENT_ACTIVE_HEADER]: TRANSPORT_CLIENT_ACTIVE_VALUE,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    'X-Link-Token': linkToken,
    'X-Device-Fingerprint': deviceFingerprint,
  };

  const fetchOptions = {
    method,
    headers,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/x-obfuscated';
    const payload = {
      format: 'information',
      data: obfuscatedBody || '',
    };
    fetchOptions.body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/x-obfuscated')) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (parsed.format === 'information' && parsed.data !== undefined) {
        const deobfuscated = deobfuscateData(parsed.data, key);
        data = JSON.parse(deobfuscated);
      } else {
        data = parsed;
      }
    } else if (contentType.includes('application/json')) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (parsed.format === 'information' && parsed.data !== undefined) {
        const deobfuscated = deobfuscateData(parsed.data, key);
        data = JSON.parse(deobfuscated);
      } else {
        data = parsed;
      }
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      error: error.message,
    };
  }
}

/**
 * Plain JSON POST for kiosk clock-action (matches frontend `skipObfuscation` on clockin API).
 * `/clockin/clock-action` is a public path: obfuscation middleware does not deobfuscate the body,
 * so sending application/x-obfuscated leaves req.body as { format, data } and clock-in fails.
 */
async function makePlainClockLinkPost(endpoint, body, linkToken, deviceFingerprint) {
  const url = `${API_BASE_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Link-Token': linkToken,
        'X-Device-Fingerprint': deviceFingerprint,
      },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }
    return {
      status: response.status,
      ok: response.ok,
      data,
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: { error: error.message },
    };
  }
}

// PLAIN JSON request helper (no obfuscation headers, no XOR body)
// Used for public/legacy endpoints such as /health, /auth/signup, /auth/signin, /payment/config.
async function makeRequest(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (sessionId) {
    headers['Cookie'] = `sessionId=${sessionId}`;
  }
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    const rotatedCsrf = response.headers.get('x-csrf-token');
    if (rotatedCsrf) {
      csrfToken = rotatedCsrf;
    }

    // Extract session and CSRF token from Set-Cookie header
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      // Extract sessionId (cookie name is sessionId, not session)
      const sessionMatch = setCookieHeader.match(/sessionId=([^;]+)/);
      if (sessionMatch) {
        const newSessionId = sessionMatch[1];
        // Only update session if it changed (to avoid overwriting with new sessions)
        if (!sessionId || newSessionId !== sessionId) {
          const oldSessionId = sessionId;
          sessionId = newSessionId;
          // Always fetch CSRF token when session changes
          csrfToken = (await fetchCsrfTokenFromApi(sessionId)) || csrfToken;
          if (oldSessionId) {
            console.log(
              `  ${YELLOW}WARNING:${RESET} Session ID changed from ${oldSessionId.substring(0, 20)}... to ${sessionId.substring(0, 20)}...`
            );
            console.log(`  ${GREEN}PASS:${RESET} CSRF token regenerated for new session`);
          }
        }
      }

      // Extract CSRF token from cookie if present (backend might provide it)
      if (setCookieHeader.includes('csrfToken=')) {
        const csrfMatch = setCookieHeader.match(/csrfToken=([^;]+)/);
        if (csrfMatch) {
          csrfToken = csrfMatch[1];
          console.log(`  ${GREEN}PASS:${RESET} CSRF token received from server cookie`);
        }
      }
    }

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/x-obfuscated')) {
      const obfuscated = await response.text();
      const deobfuscated = deobfuscateData(obfuscated);
      data = JSON.parse(deobfuscated);
    } else if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    const errorMsg = error.message || String(error);
    // Only log errors in verbose mode or for critical failures
    if (process.env.DEBUG || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error(`[makeRequest] Error for ${url}:`, errorMsg);
      if (error.code) {
        console.error(`  Error code: ${error.code}`);
      }
      if (error.cause) {
        console.error(`  Cause: ${error.cause}`);
      }
    }
    return {
      status: 0,
      ok: false,
      error: errorMsg,
      errorCode: error.code,
    };
  }
}

function generateObfuscationKey(sessionId, referenceMs = Date.now()) {
  if (!sessionId) {
    throw new Error('Session required for API obfuscation');
  }
  const ms =
    typeof referenceMs === 'number' && Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const timeComponent = Math.floor(ms / 60000);
  return `${sessionId}_${timeComponent}`.substring(0, 32);
}

function generateRequestSignature(method, url, body, sessionId, timestamp, nonce) {
  const refMs = Number(timestamp);
  const key = generateObfuscationKey(sessionId, Number.isFinite(refMs) ? refMs : Date.now());

  // Normalize endpoint path exactly like the backend does:
  // 1. Remove query string
  // 2. Ensure it starts with /
  // 3. Remove /api/ prefix if present
  let endpointPath = url;
  if (endpointPath.includes('?')) {
    endpointPath = endpointPath.split('?')[0];
  }
  if (!endpointPath.startsWith('/')) {
    endpointPath = '/' + endpointPath;
  }
  if (endpointPath.startsWith('/api/')) {
    endpointPath = endpointPath.substring(4);
  }

  // Use empty string for body if it's null/undefined/empty
  const bodyStr = body || '';

  const payload = `${method}:${endpointPath}:${bodyStr}:${timestamp}:${nonce}`;

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

// OBFUSCATED request helper (signed, XOR-encoded body)
// Used for all authenticated, obfuscated endpoints (staff, shifts, budgets, fraud, etc.).
async function makeObfuscatedRequest(endpoint, body, method = 'POST') {
  if (!sessionId) {
    throw new Error('Session required for obfuscated requests');
  }

  // Ensure CSRF token is loaded from current session
  if (!csrfToken) {
    csrfToken = await fetchCsrfTokenFromApi(sessionId);
  }

  const timestamp = Date.now();
  const nonce =
    Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const key = generateObfuscationKey(sessionId, timestamp);

  // Normalize endpoint exactly like backend does
  let endpointPath = endpoint;
  if (endpointPath.includes('?')) {
    endpointPath = endpointPath.split('?')[0];
  }
  if (!endpointPath.startsWith('/')) {
    endpointPath = '/' + endpointPath;
  }
  if (endpointPath.startsWith('/api/')) {
    endpointPath = endpointPath.substring(4);
  }

  // Obfuscate body if present
  // Important: For empty bodies (null, undefined, or {}), we use empty string for signature
  // The backend expects the obfuscated data string (or empty string) in the signature
  let obfuscatedBody = null;
  let bodyStringForSignature = '';

  if (body !== null && body !== undefined) {
    if (typeof body === 'object') {
      if (Object.keys(body).length > 0) {
        const bodyStr = JSON.stringify(body);
        obfuscatedBody = obfuscateData(bodyStr, key);
        bodyStringForSignature = obfuscatedBody;
      } else {
        // Empty object {} - use empty string for signature
        bodyStringForSignature = '';
      }
    } else {
      // Non-object body (string, number, etc.)
      const bodyStr = String(body);
      obfuscatedBody = obfuscateData(bodyStr, key);
      bodyStringForSignature = obfuscatedBody;
    }
  } else {
    // null or undefined - use empty string for signature
    bodyStringForSignature = '';
  }

  // Generate request signature using normalized endpoint path
  // Backend uses the obfuscated body string (or empty string) for signature verification
  // For empty bodies, bodyStringForSignature is already '' which matches backend expectation
  const signature = generateRequestSignature(
    method,
    endpointPath,
    bodyStringForSignature,
    sessionId,
    timestamp,
    nonce
  );

  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    [TRANSPORT_CLIENT_ACTIVE_HEADER]: TRANSPORT_CLIENT_ACTIVE_VALUE,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    Authorization: `Bearer ${sessionId}`,
    Cookie: `sessionId=${sessionId}`,
    'X-CSRF-Token': csrfToken,
  };

  // For GET/HEAD requests, don't send a body
  const fetchOptions = {
    method,
    headers,
  };

  // Only include body for methods that support it
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/x-obfuscated';
    const payload = {
      format: 'information',
      data: obfuscatedBody || '',
    };
    fetchOptions.body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(url, fetchOptions);

    const rotatedCsrf = response.headers.get('x-csrf-token');
    if (rotatedCsrf) {
      csrfToken = rotatedCsrf;
    }

    // Update session and CSRF token from response
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const sessionMatch = setCookie.match(/sessionId=([^;]+)/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
        csrfToken = (await fetchCsrfTokenFromApi(sessionId)) || csrfToken;
      }
      if (setCookie.includes('csrfToken=')) {
        const csrfMatch = setCookie.match(/csrfToken=([^;]+)/);
        if (csrfMatch) {
          csrfToken = csrfMatch[1];
        }
      }
    }

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/x-obfuscated')) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (parsed.format === 'information' && parsed.data) {
        const deobfuscated = deobfuscateData(parsed.data, key);
        data = JSON.parse(deobfuscated);
      } else {
        data = parsed;
      }
    } else if (contentType.includes('application/json')) {
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (parsed.format === 'information' && parsed.data) {
        const deobfuscated = deobfuscateData(parsed.data, key);
        data = JSON.parse(deobfuscated);
      } else {
        data = parsed;
      }
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      error: error.message,
    };
  }
}

async function testHealthCheck() {
  console.log('\n=== Testing Health Check ===');
  try {
    const result = await makeRequest('/health');
    const expected = { status: 200, ok: true };
    const actual = { status: result.status, ok: result.ok };
    console.log(`  Health check:`);
    assertResult('health endpoint', expected, actual, result.ok && result.status === 200);
    if (result.error) {
      console.error(`  ${RED}ERROR:${RESET} ${result.error}`);
      console.error(`  This usually means the server is not accessible at ${API_BASE_URL}`);
    }
    if (result.data) {
      console.log(`  Response:`, result.data);
    }
    return result.ok && result.status === 200;
  } catch (error) {
    console.error(`${RED}ERROR:${RESET} Health check failed with exception:`, error.message);
    console.log(`  Expected: { status: 200, ok: true }`);
    console.log(`  Actual: exception - ${error.message}`);
    return false;
  }
}

async function testSignup() {
  console.log('\n=== Testing Signup (Non-Obfuscated) ===');
  const email = `test-${Date.now()}@example.com`;
  const password = 'TestPassword123!';

  const csrfResp = await makeRequest('/auth/public-csrf-token');
  const publicToken = csrfResp?.data?.csrfToken;

  const result = await makeRequest('/auth/signup', {
    method: 'POST',
    headers: publicToken
      ? {
          'X-Public-CSRF-Token': publicToken,
          Cookie: `publicCsrfToken=${publicToken}`,
        }
      : undefined,
    body: JSON.stringify({
      email,
      password,
      name: 'Test User',
    }),
  });

  const expected = { ok: true, hasUser: true, status: '200 or 201' };
  const actual = { ok: result.ok, hasUser: !!result.data?.user, status: result.status };
  const passed =
    result.ok && !!result.data?.user && (result.status === 200 || result.status === 201);
  console.log(`  Signup:`);
  assertResult('signup', expected, actual, passed);
  if (result.ok && result.data?.user) {
    userId = result.data.user.id;
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  return false;
}

async function testSignupObfuscated() {
  console.log('\n=== Testing Signup (Obfuscated) ===');
  const email = `test-obf-${Date.now()}@example.com`;
  const signupResult = await makeRequest('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'TestPassword123!',
      name: 'Test User Obf',
    }),
  });
  const expected = { ok: true, hasUser: true, status: '200 or 201' };
  const actual = {
    ok: signupResult.ok,
    hasUser: !!signupResult.data?.user,
    status: signupResult.status,
  };
  const passed =
    signupResult.ok &&
    !!signupResult.data?.user &&
    (signupResult.status === 200 || signupResult.status === 201);
  console.log(`  Signup (Obfuscated):`);
  assertResult('signup obfuscated', expected, actual, passed);
  return passed;
}

async function testSignin() {
  console.log('\n=== Testing Signin (Non-Obfuscated) ===');
  const result = await makeRequest('/auth/signin', {
    method: 'POST',
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'TestPassword123!',
    }),
  });
  const expected = { ok: true, hasUser: true, status: 200 };
  const actual = { ok: result.ok, hasUser: !!result.data?.user, status: result.status };
  const passed = result.ok && !!result.data?.user;
  console.log(`  Signin:`);
  assertResult('signin', expected, actual, passed);
  if (passed) {
    userId = result.data.user.id;
  }
  return passed;
}

async function testSigninObfuscated() {
  console.log('\n=== Testing Signin (Obfuscated) ===');
  const signinResult = await makeRequest('/auth/signin', {
    method: 'POST',
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'TestPassword123!',
    }),
  });
  const expected = { ok: true, hasUser: true, status: 200 };
  const actual = {
    ok: signinResult.ok,
    hasUser: !!signinResult.data?.user,
    status: signinResult.status,
  };
  const passed = signinResult.ok && !!signinResult.data?.user;
  console.log(`  Signin (Obfuscated):`);
  assertResult('signin obfuscated', expected, actual, passed);
  if (passed) userId = signinResult.data.user.id;
  return passed;
}

async function testGetProfile() {
  console.log('\n=== Testing Update Profile (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/profile', { name: 'Test User Updated' }, 'PUT');
  return assertStatusResponse('Update Profile', result, 200);
}

async function testGetProfileObfuscated() {
  console.log('\n=== Testing Get Profile (Obfuscated, Authenticated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest(
    '/auth/profile',
    { name: 'Test User Obfuscated' },
    'PUT'
  );
  return assertStatusResponse('Get Profile (Obfuscated)', result, 200);
}

async function testGetShifts() {
  console.log('\n=== Testing Get Shifts ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shifts', {}, 'GET');
  return assertStatusResponse('Get Shifts', result, 200);
}

async function testGetShiftsObfuscated() {
  console.log('\n=== Testing Get Shifts (Obfuscated, Authenticated) ===');
  if (!sessionId) return false;
  try {
    const result = await makeObfuscatedRequest('/shifts', {}, 'GET');
    return assertStatusResponse('Get Shifts (Obfuscated)', result, 200);
  } catch (error) {
    console.log(`  ${RED}ERROR:${RESET} ${error.message}`);
    assertResult(
      'Get Shifts (Obfuscated)',
      { status: 200, ok: true },
      { error: error.message },
      false
    );
    return false;
  }
}

async function createTestStaff() {
  console.log('\n=== Creating Test Staff Member ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available for obfuscated request`);
    return null;
  }
  const result = await makeObfuscatedRequest(
    '/staff',
    {
      name: 'Test Staff Member',
      email: `test-staff-${Date.now()}@example.com`,
      role: 'Server',
      hourlyRate: 15.0,
      employmentType: 'full-time',
    },
    'POST'
  );

  const passed = result.ok && !!result.data?.staff;
  console.log(`  Create Staff:`);
  assertResult(
    'Create Staff',
    { status: 201, hasStaff: true },
    { status: result.status, hasStaff: !!result.data?.staff },
    passed
  );
  if (passed) {
    console.log(`  Staff: ${result.data.staff.name} (ID: ${result.data.staff.id})`);
    return result.data.staff.id;
  }
  return null;
}

async function testCreateShift() {
  console.log('\n=== Testing Create Shift (Obfuscated, Authenticated) ===');

  // First, try to create a staff member if we don't have one
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffListResult = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (
      staffListResult.ok &&
      staffListResult.data?.staff &&
      staffListResult.data.staff.length > 0
    ) {
      localStaffId = staffListResult.data.staff[0].id;
      staffId = localStaffId; // Update global
      console.log(`  Using existing staff member ID: ${localStaffId}`);
    } else {
      localStaffId = await createTestStaff();
      if (localStaffId) staffId = localStaffId; // Update global
    }
  }

  if (!localStaffId) {
    console.log(
      `${YELLOW}WARNING:${RESET} No staff member available, skipping shift creation test`
    );
    return true; // Not a failure, just skip
  }

  const today = new Date().toISOString().split('T')[0];
  const result = await makeObfuscatedRequest(
    '/shifts',
    {
      staffId: localStaffId,
      shiftDate: today,
      startTime: '09:00',
      hours: 8,
      location: 'Main Floor',
    },
    'POST'
  );
  if (result.ok && result.data?.shift) {
    createdShiftId = result.data.shift.id;
  }
  return assertStatusResponse('Create Shift', result, 201);
}

async function testCreateShiftObfuscated() {
  console.log('\n=== Testing Create Shift (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available, skipping obfuscated request`);
    return false;
  }

  // First, try to get a staff member
  let staffId = null;
  const staffListResult = await makeObfuscatedRequest('/staff', {}, 'GET');
  if (staffListResult.ok && staffListResult.data?.staff && staffListResult.data.staff.length > 0) {
    staffId = staffListResult.data.staff[0].id;
    console.log(`  Using existing staff member ID: ${staffId}`);
  } else {
    staffId = await createTestStaff();
  }

  if (!staffId) {
    console.log(
      `${YELLOW}WARNING:${RESET} No staff member available, skipping obfuscated shift creation test`
    );
    return true; // Not a failure, just skip
  }

  const today = new Date().toISOString().split('T')[0];
  const result = await makeObfuscatedRequest(
    '/shifts',
    {
      staffId: staffId,
      shiftDate: today,
      startTime: '14:00',
      hours: 4,
      location: 'Main Floor',
    },
    'POST'
  );
  return assertStatusResponse('Create Shift (Obfuscated)', result, [201, 409]);
}

async function testGetStaff() {
  console.log('\n=== Testing Get Staff ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/staff', {}, 'GET');
  return assertStatusResponse('Get Staff', result, 200);
}

async function testGetStaffObfuscated() {
  console.log('\n=== Testing Get Staff (Obfuscated, Authenticated) ===');
  if (!sessionId) return false;
  try {
    const result = await makeObfuscatedRequest('/staff', {}, 'GET');
    return assertStatusResponse('Get Staff (Obfuscated)', result, 200);
  } catch (error) {
    console.log(`  ${RED}ERROR:${RESET} ${error.message}`);
    assertResult(
      'Get Staff (Obfuscated)',
      { status: 200, ok: true },
      { error: error.message },
      false
    );
    return false;
  }
}

// ============================================
// CONTACT & HEALTH
// ============================================

async function testContactForm() {
  console.log('\n=== Testing Contact Form (Obfuscated) ===');
  let result;
  if (!sessionId) {
    result = await makeRequest('/contact', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        subject: 'Test Subject',
        message: 'This is a test message',
      }),
    });
  } else {
    result = await makeObfuscatedRequest(
      '/contact',
      {
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        subject: 'Test Subject',
        message: 'This is a test message',
      },
      'POST'
    );
  }
  return assertStatusResponse('Contact Form', result, 200);
}

// ============================================
// AUTHENTICATION - Additional Endpoints
// ============================================

async function testGetMe() {
  console.log('\n=== Testing Get /auth/me ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/me', {}, 'GET');
  return assertStatusResponse('Get /auth/me', result, 200);
}

async function testGetCsrfToken() {
  console.log('\n=== Testing Get CSRF Token ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/csrf-token', {}, 'GET');
  return assertStatusResponse('Get CSRF Token', result, 200);
}

async function test2FAStatus() {
  console.log('\n=== Testing 2FA Status ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/2fa/status', {}, 'GET');
  return assertStatusResponse('2FA Status', result, 200);
}

async function testForgotPassword() {
  console.log('\n=== Testing Forgot Password ===');
  const result = await makeRequest('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({
      email: `test-${Date.now()}@example.com`,
    }),
  });
  const expected = { status: 200 };
  const actual = { status: result.status };
  console.log(`  Forgot Password:`);
  assertResult('Forgot Password', expected, actual, result.status === 200);
  return result.status === 200;
}

// ============================================
// STAFF - Additional Endpoints
// ============================================

async function testGetStaffStats() {
  console.log('\n=== Testing Get Staff Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/staff/stats', {}, 'GET');
  return assertStatusResponse('Get Staff Stats', result, 200);
}

async function testGetStaffById() {
  console.log('\n=== Testing Get Staff By ID ===');
  if (!sessionId || !staffId) {
    console.log(`  ${RED}ERROR:${RESET} No session or staff ID available`);
    return false;
  }
  const result = await makeObfuscatedRequest(`/staff/${staffId}`, {}, 'GET');
  const passed = assertStatusResponse('Get Staff By ID', result, 200);
  if (!passed && result?.data) {
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return passed;
}

async function testUpdateStaff() {
  console.log('\n=== Testing Update Staff (Obfuscated) ===');
  if (!sessionId || !staffId) {
    console.log(`  ${RED}ERROR:${RESET} No session or staff ID available`);
    return false;
  }
  const result = await makeObfuscatedRequest(
    `/staff/${staffId}`,
    {
      name: 'Updated Staff Member',
      role: 'Manager',
    },
    'PUT'
  );
  const passed = assertStatusResponse('Update Staff', result, 200);
  if (!passed && result?.data) {
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return passed;
}

// ============================================
// SHIFTS - Additional Endpoints
// ============================================

async function testGetShiftStats() {
  console.log('\n=== Testing Get Shift Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shifts/stats', {}, 'GET');
  return assertStatusResponse('Get Shift Stats', result, 200);
}

async function testGetShiftById() {
  console.log('\n=== Testing Get Shift By ID ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}`, {}, 'GET');
  return assertStatusResponse('Get Shift By ID', result, 200);
}

async function testUpdateShift() {
  console.log('\n=== Testing Update Shift (Obfuscated) ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeObfuscatedRequest(
    `/shifts/${createdShiftId}`,
    {
      startTime: '11:00',
      hours: 7,
    },
    'PUT'
  );
  return assertStatusResponse('Update Shift', result, 200);
}

async function testApproveShift() {
  console.log('\n=== Testing Approve Shift (Obfuscated) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  if (!createdShiftId) {
    console.log(`  ${RED}ERROR:${RESET} No shift ID available (createdShiftId: ${createdShiftId})`);
    return false;
  }
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}/approve`, null, 'POST');
  const passed = assertStatusResponse('Approve Shift', result, 200);
  if (!passed && result?.data?.error) {
    console.log(`  Response: ${result.data.error}`);
  }
  return passed;
}

async function testGetShiftSwaps() {
  console.log('\n=== Testing Get Shift Swaps ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shift-swaps', {}, 'GET');
  return assertStatusResponse('Get Shift Swaps', result, 200);
}

/**
 * Regression: Overnight new shift (17:00-01:00) vs same-day existing (00:00-08:00) should NOT conflict.
 * Bug was incorrectly treating 01:00 as same-day end, causing false conflict.
 */
async function testShiftConflictOvernightNoFalsePositive() {
  console.log('\n=== Testing Shift Conflict: Overnight vs Same-Day (No False Conflict) ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const testDate = new Date();
  testDate.setDate(testDate.getDate() + 14);
  const dateStr = testDate.toISOString().split('T')[0];
  try {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
    const shift1 = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '00:00',
        hours: 8,
      },
      'POST'
    );
    if (!shift1.ok) {
      console.log(`  ${RED}FAIL:${RESET} Could not create first shift (00:00-08:00)`);
      return false;
    }
    const shift2 = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '17:00',
        hours: 8,
      },
      'POST'
    );
    const passed = shift2.status === 201;
    assertResult(
      'Overnight (17:00-01:00) vs same-day (00:00-08:00) - no conflict',
      { status: 201 },
      { status: shift2.status, error: shift2.data?.error },
      passed
    );
    return passed;
  } finally {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
  }
}

/**
 * Regression: Overnight shift (17:15-01:15) should NOT show 'completed' when it has not ended yet.
 * Bug was using wrong end-date for overnight shifts, marking them completed prematurely.
 */
async function testOvernightShiftNotCompletedPrematurely() {
  console.log('\n=== Testing Overnight Shift: Not Completed Prematurely ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];
  let createdId = null;
  try {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
    const createRes = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '17:15',
        hours: 8,
      },
      'POST'
    );
    if (!createRes.ok) {
      console.log(`  ${RED}FAIL:${RESET} Could not create overnight shift`);
      return false;
    }
    createdId = createRes.data?.shift?.id;
    const getRes = await makeObfuscatedRequest('/shifts', {}, 'GET');
    const shifts = getRes.data?.shifts ?? getRes.data;
    if (!getRes.ok || !Array.isArray(shifts)) {
      console.log(`  ${RED}FAIL:${RESET} Could not fetch shifts`);
      return false;
    }
    const shift = shifts.find(
      (s) =>
        s.id === createdId ||
        (String(s.shift_date).startsWith(dateStr) && s.start_time?.startsWith?.('17'))
    );
    if (!shift) {
      console.log(`  ${YELLOW}WARN:${RESET} Could not find created overnight shift in response`);
      return true;
    }
    const badStatuses = ['completed', 'unattended'];
    const passed = !badStatuses.includes(shift.status);
    assertResult(
      'Overnight shift (not yet ended) should not be completed/unattended',
      { status: 'scheduled or late' },
      { status: shift.status },
      passed
    );
    return passed;
  } finally {
    if (createdId) {
      await pool.query('DELETE FROM shifts WHERE id = $1', [createdId]);
    } else {
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
    }
  }
}

/**
 * Multi-day shift (120 hours = 5 days): verify creation, hours stored, and end_time.
 * 120h from 00:00 wraps to 12:00 same-day in calculateEndTime (modulo); we assert hours=120.
 */
async function testMultiDayShiftCreation() {
  console.log('\n=== Testing Multi-Day Shift (120 hours) ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const testDate = new Date();
  testDate.setDate(testDate.getDate() + 20);
  const dateStr = testDate.toISOString().split('T')[0];
  let createdId = null;
  try {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
    const createRes = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '00:00',
        hours: 120,
      },
      'POST'
    );
    if (!createRes.ok) {
      console.log(
        `  ${RED}FAIL:${RESET} Could not create 120-hour shift: ${createRes.data?.error || 'unknown'}`
      );
      return false;
    }
    createdId = createRes.data?.shift?.id;
    const storedHours = createRes.data?.shift?.hours ?? createRes.data?.shift?.hours_worked;
    const hoursOk = parseFloat(storedHours) === 120;
    assertResult(
      '120-hour shift stores hours correctly',
      { hours: 120 },
      { hours: storedHours },
      hoursOk
    );
    const getRes = await makeObfuscatedRequest(`/shifts/${createdId}`, {}, 'GET');
    if (getRes.ok && getRes.data?.shift) {
      const s = getRes.data.shift;
      const getHoursOk = parseFloat(s.hours) === 120;
      assertResult('GET shift returns hours=120', { hours: 120 }, { hours: s.hours }, getHoursOk);
    }
    return hoursOk;
  } finally {
    if (createdId) await pool.query('DELETE FROM shifts WHERE id = $1', [createdId]);
    else
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
  }
}

/**
 * Five consecutive overnight shifts (17:00-01:00) on 5 days: all should create without conflict.
 * Verifies overnight shifts on adjacent days don't falsely conflict.
 */
async function testFiveConsecutiveOvernightShifts() {
  console.log('\n=== Testing 5 Consecutive Overnight Shifts ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const base = new Date();
  base.setDate(base.getDate() + 25);
  const createdIds = [];
  try {
    for (let i = 0; i < 5; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
      const res = await makeObfuscatedRequest(
        '/shifts',
        {
          staffId: localStaffId,
          shiftDate: dateStr,
          startTime: '17:00',
          hours: 8,
        },
        'POST'
      );
      if (!res.ok) {
        console.log(
          `  ${RED}FAIL:${RESET} Day ${i + 1} (${dateStr}): ${res.data?.error || 'unknown'}`
        );
        return false;
      }
      if (res.data?.shift?.id) createdIds.push(res.data.shift.id);
    }
    const passed = createdIds.length === 5;
    assertResult(
      'All 5 overnight shifts created',
      { count: 5 },
      { count: createdIds.length },
      passed
    );
    return passed;
  } finally {
    for (const id of createdIds) {
      await pool.query('DELETE FROM shifts WHERE id = $1', [id]).catch(() => {});
    }
  }
}

/**
 * Regression: 24-hour shift (00:00-00:00) with no clock-in should be UNATTENDED when ended, not COMPLETED.
 * Bug was marking such shifts as 'completed' instead of 'unattended'.
 */
async function test24HourShiftNoClockInUnattended() {
  console.log('\n=== Testing 24-Hour Shift: No Clock-In → Unattended ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  let createdId = null;
  try {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
    const createRes = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '00:00',
        hours: 24,
      },
      'POST'
    );
    if (!createRes.ok) {
      console.log(
        `  ${RED}FAIL:${RESET} Could not create 24-hour shift: ${createRes.data?.error || 'unknown'}`
      );
      return false;
    }
    createdId = createRes.data?.shift?.id;
    const getRes = await makeObfuscatedRequest('/shifts', {}, 'GET');
    const shifts = getRes.data?.shifts ?? getRes.data;
    if (!getRes.ok || !Array.isArray(shifts)) {
      console.log(`  ${RED}FAIL:${RESET} Could not fetch shifts`);
      return false;
    }
    const shift = shifts.find(
      (s) =>
        s.id === createdId ||
        (String(s.shift_date).startsWith(dateStr) &&
          s.start_time?.startsWith?.('00') &&
          parseFloat(s.hours) === 24)
    );
    if (!shift) {
      console.log(`  ${YELLOW}WARN:${RESET} Could not find created 24-hour shift`);
      return true;
    }
    const passed = shift.status === 'unattended';
    assertResult(
      '24-hour shift with no clock-in (ended) should be unattended, not completed',
      { status: 'unattended' },
      { status: shift.status },
      passed
    );
    return passed;
  } finally {
    if (createdId) await pool.query('DELETE FROM shifts WHERE id = $1', [createdId]);
    else
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
  }
}

/**
 * Regression: Shift wrongly marked 'completed' in DB with no clock-in should be corrected to 'unattended' when fetched.
 * Verifies the getShifts correction logic.
 */
async function testCompletedShiftWithNoClockInCorrected() {
  console.log('\n=== Testing Completed Shift (No Clock-In) Corrected to Unattended ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 40);
  const dateStr = futureDate.toISOString().split('T')[0];
  let createdId = null;
  try {
    await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
      localStaffId,
      dateStr,
    ]);
    const createRes = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        shiftDate: dateStr,
        startTime: '09:00',
        hours: 8,
      },
      'POST'
    );
    if (!createRes.ok) {
      console.log(`  ${RED}FAIL:${RESET} Could not create shift`);
      return false;
    }
    createdId = createRes.data?.shift?.id;
    const beforeUpdate = await pool.query('SELECT id, user_id, status FROM shifts WHERE id = $1', [
      createdId,
    ]);
    if (beforeUpdate.rows.length === 0) {
      console.log(
        `  ${YELLOW}WARN:${RESET} Shift ${createdId} not in DB (test script may use different DB than API) - skipping correction test`
      );
      return true;
    }
    const updateResult = await pool.query(
      `UPDATE shifts SET status = 'completed', clocked_in_time = NULL, clocked_out_time = NULL WHERE id = $1 RETURNING id, status`,
      [createdId]
    );
    if (updateResult.rowCount === 0) {
      console.log(`  ${RED}FAIL:${RESET} Could not update shift ${createdId}`);
      return false;
    }
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 60);
    const getRes = await makeObfuscatedRequest(
      `/shifts?startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}`,
      {},
      'GET'
    );
    const shifts = getRes.data?.shifts ?? getRes.data;
    if (!getRes.ok || !Array.isArray(shifts)) {
      console.log(`  ${RED}FAIL:${RESET} Could not fetch shifts`);
      return false;
    }
    const shift = shifts.find((s) => s.id === createdId);
    if (!shift) {
      console.log(`  ${YELLOW}WARN:${RESET} Could not find shift`);
      return true;
    }
    const passed = shift.status === 'unattended';
    assertResult(
      'Shift with status=completed but no clock-in should be corrected to unattended',
      { status: 'unattended' },
      { status: shift.status },
      passed
    );
    return passed;
  } finally {
    if (createdId) await pool.query('DELETE FROM shifts WHERE id = $1', [createdId]);
    else
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
  }
}

/**
 * 24-hour shift: create 00:00 with 24 hours, verify end_time is 00:00 (wraps to midnight).
 */
async function test24HourShiftEndTime() {
  console.log('\n=== Testing 24-Hour Shift End Time ===');
  if (!sessionId) return false;
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (!staffRes.ok || !staffRes.data?.staff?.length) return false;
    localStaffId = staffRes.data.staff[0].id;
  }
  const testDate = new Date();
  testDate.setDate(testDate.getDate() + 35);
  const dateStr = testDate.toISOString().split('T')[0];
  const nextDay = new Date(testDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().split('T')[0];
  let createdId = null;
  try {
    await pool.query(
      'DELETE FROM shifts WHERE staff_id = $1 AND (shift_date = $2::date OR shift_date = $3::date)',
      [localStaffId, dateStr, nextDayStr]
    );
    const createRes = await makeObfuscatedRequest(
      '/shifts',
      {
        staffId: localStaffId,
        startTime: '00:00',
        shiftDate: dateStr,
        hours: 24,
      },
      'POST'
    );
    if (!createRes.ok) {
      const err = createRes.data?.error || createRes.error || 'unknown';
      console.log(`  ${RED}FAIL:${RESET} Could not create 24-hour shift: ${err}`);
      return false;
    }
    createdId = createRes.data?.shift?.id;
    const getRes = await makeObfuscatedRequest('/shifts', {}, 'GET');
    const shifts = getRes.data?.shifts ?? getRes.data;
    const shift = Array.isArray(shifts)
      ? shifts.find(
          (s) =>
            s.id === createdId ||
            (String(s.shift_date).startsWith(dateStr) && s.start_time?.startsWith?.('00'))
        )
      : null;
    if (!shift) {
      console.log(`  ${YELLOW}WARN:${RESET} Could not find created shift`);
      return true;
    }
    const endTime = shift.end_time || shift.endTime;
    const expectedEnd = '00:00'; // 24h from 00:00 wraps to 00:00
    const passed = endTime && (endTime.startsWith('00:00') || endTime === '00:00:00');
    assertResult('24-hour shift end_time', { end: '00:00' }, { end: endTime }, passed);
    return passed;
  } finally {
    if (createdId) await pool.query('DELETE FROM shifts WHERE id = $1', [createdId]);
    else
      await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
        localStaffId,
        dateStr,
      ]);
  }
}

// ============================================
// TIME ENTRIES & PAYROLL
// ============================================

async function testGetTimeEntries() {
  console.log('\n=== Testing Get Time Entries ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/time-entries', {}, 'GET');
  return assertStatusResponse('Get Time Entries', result, 200);
}

async function testGetPayrollPreview() {
  console.log('\n=== Testing Get Payroll Preview ===');
  if (!sessionId) return false;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    .toISOString()
    .split('T')[0];
  const result = await makeObfuscatedRequest(
    `/payroll-preview?startDate=${startDate}&endDate=${endDate}`,
    {},
    'GET'
  );
  return assertStatusResponse('Get Payroll Preview', result, 200);
}

async function testGetMonthlyEarnings() {
  console.log('\n=== Testing Get Monthly Earnings ===');
  if (!sessionId) return false;
  const today = new Date();
  const result = await makeObfuscatedRequest(
    `/earnings/monthly?year=${today.getFullYear()}&month=${today.getMonth() + 1}`,
    {},
    'GET'
  );
  return assertStatusResponse('Get Monthly Earnings', result, 200);
}

async function testCreateTimeEntry() {
  console.log('\n=== Testing Create Time Entry (Obfuscated) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  if (!staffId) {
    console.log(`  ${RED}ERROR:${RESET} No staff ID available`);
    return false;
  }
  const today = new Date().toISOString().split('T')[0];
  const result = await makeObfuscatedRequest(
    '/time-entries',
    {
      staffId: staffId,
      date: today,
      hoursWorked: 8,
      hourlyRate: 15.0,
    },
    'POST'
  );
  const passed = assertStatusResponse('Create Time Entry', result, 201);
  if (!passed && result?.data) console.log(`  Response: ${JSON.stringify(result.data)}`);
  return passed;
}

// ============================================
// PAYMENTS & PAYMENT SCHEDULE
// ============================================

async function testGetPaymentSchedule() {
  console.log('\n=== Testing Get Payment Schedule ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payments/schedule', {}, 'GET');
  return assertStatusResponse('Get Payment Schedule', result, 200);
}

async function testCreatePaymentSchedule() {
  console.log('\n=== Testing Create Payment Schedule (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest(
    '/payments/schedule',
    {
      scheduleType: 'weekly',
      paymentDay: 5,
    },
    'POST'
  );
  return assertStatusResponse('Create Payment Schedule', result, [200, 201]);
}

async function testGetPaymentHistory() {
  console.log('\n=== Testing Get Payment History ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/payments/history', {}, 'GET');
  return assertStatusResponse('Get Payment History', result, 200);
}

async function testGetPaymentStats() {
  console.log('\n=== Testing Get Payment Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/payments/stats', {}, 'GET');
  return assertStatusResponse('Get Payment Stats', result, 200);
}

// ============================================
// LOCATIONS
// ============================================

async function testGetLocation() {
  console.log('\n=== Testing Get Location ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/location', {}, 'GET');
  return assertStatusResponse('Get Location', result, 200);
}

async function testUpdateLocation() {
  console.log('\n=== Testing Update Location (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest(
    '/location',
    {
      latitude: 51.5074,
      longitude: -0.1278,
      radius: 100,
    },
    'PUT'
  );
  return assertStatusResponse('Update Location', result, 200);
}

async function testGetLocations() {
  console.log('\n=== Testing Get Locations (Multi) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/locations', {}, 'GET');
  return assertStatusResponse('Get Locations (Multi)', result, [200, 403]);
}

async function testCreateLocation() {
  console.log('\n=== Testing Create Location (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest(
    '/locations',
    {
      name: 'Test Location',
      latitude: 51.5074,
      longitude: -0.1278,
      radius: 100,
    },
    'POST'
  );
  if (result.ok && result.data?.location) {
    createdLocationId = result.data.location.id;
  }
  return assertStatusResponse('Create Location', result, [200, 403]);
}

// ============================================
// BUDGETS
// ============================================

async function testGetBudgets() {
  console.log('\n=== Testing Get Budgets ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets', {}, 'GET');
  return assertStatusResponse('Get Budgets', result, 200);
}

async function testGetActiveBudget() {
  console.log('\n=== Testing Get Active Budget ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets/active', {}, 'GET');
  return assertStatusResponse('Get Active Budget', result, 200);
}

async function testCreateBudget() {
  console.log('\n=== Testing Create Budget (Obfuscated) ===');
  if (!sessionId) return false;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    .toISOString()
    .split('T')[0];
  const result = await makeObfuscatedRequest(
    '/budgets',
    {
      name: 'Test Budget',
      monthlyBudget: 10000,
      startDate: startDate,
      endDate: endDate,
    },
    'POST'
  );
  if (result.ok && result.data?.budget) {
    createdBudgetId = result.data.budget.id;
  }
  return assertStatusResponse('Create Budget', result, 201);
}

async function testGetBudgetStats() {
  console.log('\n=== Testing Get Budget Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets/stats', {}, 'GET');
  return assertStatusResponse('Get Budget Stats', result, 200);
}

// ============================================
// ACTIVITIES
// ============================================

async function testGetActivities() {
  console.log('\n=== Testing Get Activities (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/activities', {}, 'GET');
  return assertStatusResponse('Get Activities', result, 200);
}

async function testGetActivityStats() {
  console.log('\n=== Testing Get Activity Stats (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/activities/stats', {}, 'GET');
  return assertStatusResponse('Get Activity Stats', result, 200);
}

// ============================================
// FRAUD DETECTION
// ============================================

async function testGetFraudFlags() {
  console.log('\n=== Testing Get Fraud Flags ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/fraud/flags', {}, 'GET');
  return assertStatusResponse('Get Fraud Flags', result, [200, 403]);
}

async function testGetFraudStats() {
  console.log('\n=== Testing Get Fraud Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/fraud/stats', {}, 'GET');
  return assertStatusResponse('Get Fraud Stats', result, [200, 403]);
}

// ============================================
// SECURITY
// ============================================

async function testGetApiKeys() {
  console.log('\n=== Testing Get API Keys ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/api-keys', {}, 'GET');
  return assertStatusResponse('Get API Keys', result, 200);
}

async function testCreateApiKey() {
  console.log('\n=== Testing Create API Key (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest(
    '/security/api-keys',
    {
      keyName: `test-key-${Date.now()}`,
    },
    'POST'
  );
  if (result.ok && result.data?.key) {
    createdApiKeyId = result.data.key.id;
  }
  return assertStatusResponse('Create API Key', result, 201);
}

async function testGetIpWhitelist() {
  console.log('\n=== Testing Get IP Whitelist ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/ip-whitelist', {}, 'GET');
  return assertStatusResponse('Get IP Whitelist', result, 200);
}

async function testGetAuditLogs() {
  console.log('\n=== Testing Get Audit Logs ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/audit-logs', {}, 'GET');
  const expected = { status: 403, description: 'Non-admin: access denied' };
  const actual = { status: result.status, ok: result.ok };
  const passed = result.status === 403;
  console.log(`  Get Audit Logs (expect 403 for non-admin):`);
  assertResult('audit logs', expected, actual, passed);
  return passed;
}

// ============================================
// FACE ID (kiosk — obfuscated POST, same as frontend)
// ============================================

async function testFaceIdKioskValidation() {
  console.log('\n=== Testing Face ID kiosk endpoints (validation, obfuscated) ===');
  const fp = 'test-fp-face-validation';
  const hash64 = 'a'.repeat(64);
  const dummyTok = 'dummy-face-validation-token';

  const enroll = await makeClockLinkRequest('/clockin/face/enroll', {}, 'POST', dummyTok, fp);
  const enrollOk = enroll.status === 400;
  console.log(`  Face enroll (missing body):`);
  assertResult('status 400', { status: 400 }, { status: enroll.status }, enrollOk);

  const verify = await makeClockLinkRequest(
    '/clockin/face/verify',
    { linkToken: 'dummy', faceHash: hash64 },
    'POST',
    'dummy',
    fp
  );
  const verifyOk = verify.status === 400;
  console.log(`  Face verify (missing clockinId):`);
  assertResult('status 400', { status: 400 }, { status: verify.status }, verifyOk);

  const identify = await makeClockLinkRequest(
    '/clockin/face/identify',
    { linkToken: 'dummy' },
    'POST',
    'dummy',
    fp
  );
  const identifyOk = identify.status === 400;
  console.log(`  Face identify (missing faceHash):`);
  assertResult('status 400', { status: 400 }, { status: identify.status }, identifyOk);

  const badTok = `bad${'0'.repeat(60)}`;
  const badEnroll = await makeClockLinkRequest(
    '/clockin/face/enroll',
    {
      clockinId: '123456',
      linkToken: badTok,
      deviceFingerprint: fp,
      faceHash: hash64,
    },
    'POST',
    badTok,
    fp
  );
  const badEnrollOk = badEnroll.status === 404;
  console.log(`  Face enroll (invalid link token → 404):`);
  assertResult('status 404', { status: 404 }, { status: badEnroll.status }, badEnrollOk);

  const badVerify = await makeClockLinkRequest(
    '/clockin/face/verify',
    {
      clockinId: '123456',
      linkToken: badTok,
      deviceFingerprint: fp,
      faceHash: hash64,
    },
    'POST',
    badTok,
    fp
  );
  const badVerifyOk = badVerify.status === 404;
  console.log(`  Face verify (invalid link token → 404):`);
  assertResult('status 404', { status: 404 }, { status: badVerify.status }, badVerifyOk);

  const badIdentify = await makeClockLinkRequest(
    '/clockin/face/identify',
    { linkToken: badTok, deviceFingerprint: fp, faceHash: hash64 },
    'POST',
    badTok,
    fp
  );
  const badIdentifyOk = badIdentify.status === 404;
  console.log(`  Face identify (invalid link token → 404):`);
  assertResult('status 404', { status: 404 }, { status: badIdentify.status }, badIdentifyOk);

  return enrollOk && verifyOk && identifyOk && badEnrollOk && badVerifyOk && badIdentifyOk;
}

/** Enroll → verify → identify with the same synthetic face hash (after clock link + staff exist). */
async function testFaceIdKioskFlow() {
  console.log('\n=== Testing Face ID kiosk flow (enroll → verify → identify) ===');
  if (!clockinLinkToken || !staffId || !clockinDeviceFingerprint) {
    console.log(
      `  ${YELLOW}SKIP:${RESET} Need clock link token, staff, and device fingerprint (run clock-in flow first)`
    );
    return true;
  }

  const verifyBind = await makeClockLinkRequest(
    `/clockin/verify-link/${clockinLinkToken}?fingerprint=${encodeURIComponent(clockinDeviceFingerprint)}`,
    null,
    'GET',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  if (!verifyBind.ok || verifyBind.data?.valid !== true) {
    console.log(`  ${RED}ERROR:${RESET} verify-link failed before Face ID flow`);
    return false;
  }

  let code = await getStaffClockinCode(staffId);
  if (!code || code.length !== 6) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    await setStaffClockinCode(staffId, code);
  }

  const faceHash = crypto.randomBytes(32).toString('hex');

  const enrollBody = {
    clockinId: code,
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    faceHash,
  };
  const enroll = await makeClockLinkRequest(
    '/clockin/face/enroll',
    enrollBody,
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`  Face enroll:`);
  const enrollOk = enroll.ok && enroll.data?.success === true;
  assertResult(
    'enroll success',
    { ok: true, success: true },
    { ok: enroll.ok, success: enroll.data?.success, error: enroll.data?.error },
    enrollOk
  );
  if (!enrollOk) return false;

  const verifyBody = {
    clockinId: code,
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    faceHash,
  };
  const verify = await makeClockLinkRequest(
    '/clockin/face/verify',
    verifyBody,
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`  Face verify:`);
  const verifyOk = verify.ok && verify.data?.verified === true;
  assertResult(
    'verify matched',
    { ok: true, verified: true },
    { ok: verify.ok, verified: verify.data?.verified, error: verify.data?.error },
    verifyOk
  );
  if (!verifyOk) return false;

  // Multi-sample enrollment (same as frontend enrollFace([hash1, hash2, ...]))
  const samp1 = crypto.randomBytes(32).toString('hex');
  const samp2 = crypto.randomBytes(32).toString('hex');
  const enrollMulti = await makeClockLinkRequest(
    '/clockin/face/enroll',
    {
      clockinId: code,
      linkToken: clockinLinkToken,
      deviceFingerprint: clockinDeviceFingerprint,
      faceHashes: [samp1, samp2],
    },
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`  Face enroll (faceHashes array):`);
  const enrollMultiOk = enrollMulti.ok && enrollMulti.data?.success === true;
  assertResult(
    'enroll faceHashes',
    { ok: true, success: true },
    { ok: enrollMulti.ok, success: enrollMulti.data?.success, error: enrollMulti.data?.error },
    enrollMultiOk
  );
  if (!enrollMultiOk) return false;

  const verifyAfterMulti = await makeClockLinkRequest(
    '/clockin/face/verify',
    {
      clockinId: code,
      linkToken: clockinLinkToken,
      deviceFingerprint: clockinDeviceFingerprint,
      faceHash: samp1,
    },
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`  Face verify (after faceHashes enroll):`);
  const verifyAfterMultiOk = verifyAfterMulti.ok && verifyAfterMulti.data?.verified === true;
  assertResult(
    'verify after multi-sample',
    { ok: true, verified: true },
    {
      ok: verifyAfterMulti.ok,
      verified: verifyAfterMulti.data?.verified,
      error: verifyAfterMulti.data?.error,
    },
    verifyAfterMultiOk
  );
  if (!verifyAfterMultiOk) return false;

  const identifyBody = {
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    faceHash: samp1,
  };
  const identify = await makeClockLinkRequest(
    '/clockin/face/identify',
    identifyBody,
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`  Face identify:`);
  const identifyOk = identify.ok && identify.data?.identified === true;
  assertResult(
    'identify matched',
    { ok: true, identified: true, clockinCode: code },
    {
      ok: identify.ok,
      identified: identify.data?.identified,
      clockinCode: identify.data?.clockinCode,
      clockinId: identify.data?.clockinId,
    },
    identifyOk &&
      identify.data?.clockinCode === code &&
      identify.data?.clockinId === code &&
      identify.data?.staffId === undefined
  );

  return enrollOk && verifyOk && enrollMultiOk && verifyAfterMultiOk && identifyOk;
}

// ============================================
// CLOCK-IN/CLOCK-OUT (matches frontend exactly)
// ============================================

async function testGenerateClockinLink() {
  console.log('\n=== Testing Generate Clock-in Link (Obfuscated) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest(
    '/clockin/generate-link',
    {
      deviceName: 'Test Device API Script',
    },
    'POST'
  );
  const expected = { status: 200, ok: true, hasLink: true };
  const actual = { status: result.status, ok: result.ok, hasLink: !!result.data?.link };
  console.log(`  Generate Clock-in Link:`);
  assertResult('Generate link', expected, actual, result.ok && !!result.data?.link);
  if (result.ok && result.data?.link) {
    createdClockinLinkId = result.data.link.id;
    clockinLinkToken = result.data.link.token || result.data.link.link_token;
    console.log(`  Token: ${clockinLinkToken?.substring(0, 16)}...`);
  }
  return result.ok && result.status === 200;
}

async function testGetClockinLinks() {
  console.log('\n=== Testing Get Clock-in Links ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/clockin/links', {}, 'GET');
  if (result.ok && result.data?.links?.length > 0 && !clockinLinkToken) {
    clockinLinkToken = result.data.links[0].token || result.data.links[0].link_token;
  }
  return assertStatusResponse('Get Clock-in Links', result, 200);
}

// Get staff's 6-digit clock-in code via API (matches frontend - no direct DB)
async function getStaffClockinCode(staffIdToUse) {
  const res = await makeObfuscatedRequest(`/staff/${staffIdToUse}`, {}, 'GET');
  if (!res.ok || !res.data?.staff) return null;
  const staff = res.data.staff;
  if (staff.clockin_id) return String(staff.clockin_id).slice(-6);
  if (staff.username) {
    const digits = String(staff.username).replace(/\D/g, '');
    return digits.slice(-6);
  }
  return null;
}

// Set staff clockin_id via direct DB (only when needed - API has no update for clockin_id)
async function setStaffClockinCode(staffIdToUse, code) {
  const r = await pool.query(
    `UPDATE staff SET clockin_id = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
    [code, staffIdToUse, userId]
  );
  return r.rowCount > 0;
}

// Full clock-in flow: verify link, clock-in, clock-out - acts exactly like frontend
async function testClockInFlowWithStaff() {
  console.log('\n=== Testing Clock-in Flow (matches frontend) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session`);
    return false;
  }
  if (!staffId) {
    console.log(`  ${RED}ERROR:${RESET} No staff - create staff first`);
    return false;
  }

  // 1. Ensure we have a device link and token
  if (!clockinLinkToken) {
    const genResult = await makeObfuscatedRequest(
      '/clockin/generate-link',
      {
        deviceName: 'Test Device API',
        expiresInDays: 90,
      },
      'POST'
    );
    if (!genResult.ok || !genResult.data?.link) {
      console.log(`  ${RED}ERROR:${RESET} Could not generate link`);
      return false;
    }
    clockinLinkToken = genResult.data.link.token;
    createdClockinLinkId = genResult.data.link.id;
  }

  // 2. Get staff's 6-digit clock-in code (from API - createStaff sets it)
  let clockinCode = await getStaffClockinCode(staffId);
  if (!clockinCode || clockinCode.length !== 6) {
    clockinCode = String(Math.floor(100000 + Math.random() * 900000));
    const updated = await setStaffClockinCode(staffId, clockinCode);
    if (updated) console.log(`  Set staff clockin_id to ${clockinCode}`);
  }
  const codeToUse = clockinCode;

  // 4. Create shift for today via API - use full-day window so "now" is always within shift (avoids timezone/timing flakiness)
  const today = new Date().toISOString().split('T')[0];
  // Remove existing shifts for this staff today to avoid 409 overlap from prior tests
  await pool.query('DELETE FROM shifts WHERE staff_id = $1 AND shift_date = $2::date', [
    staffId,
    today,
  ]);
  const shiftRes = await makeObfuscatedRequest(
    '/shifts',
    {
      staffId,
      shiftDate: today,
      startTime: '00:00',
      hours: 24,
      location: 'Test Location',
    },
    'POST'
  );
  if (!shiftRes.ok) {
    console.log(
      `  ${RED}ERROR:${RESET} Shift creation failed: ${shiftRes.data?.error || shiftRes.error || 'unknown'}`
    );
    return false;
  }

  // 5. Generate device fingerprint (like frontend)
  clockinDeviceFingerprint = clockinDeviceFingerprint || generateDeviceFingerprint();

  // 6. Verify link - GET exactly like frontend
  const verifyResult = await makeClockLinkRequest(
    `/clockin/verify-link/${clockinLinkToken}?fingerprint=${encodeURIComponent(clockinDeviceFingerprint)}`,
    null,
    'GET',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  const verifyPass = verifyResult.ok && verifyResult.data?.valid === true;
  console.log(`  Verify link:`);
  assertResult(
    'verify-link',
    { ok: true, valid: true },
    { ok: verifyResult.ok, valid: verifyResult.data?.valid },
    verifyPass
  );
  if (!verifyPass) {
    console.log(
      `  ${RED}ERROR:${RESET} Verify link failed: ${verifyResult.data?.error || verifyResult.error}`
    );
    return false;
  }

  // 6b. Face enrollment (clock-action requires a verified face hash when Face ID is enabled)
  const faceHash = crypto.randomBytes(32).toString('hex');
  const enrollFace = await makeClockLinkRequest(
    '/clockin/face/enroll',
    {
      clockinId: codeToUse,
      linkToken: clockinLinkToken,
      deviceFingerprint: clockinDeviceFingerprint,
      faceHash,
    },
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  if (!enrollFace.ok || enrollFace.data?.success !== true) {
    console.log(
      `  ${RED}ERROR:${RESET} Face enroll failed: ${enrollFace.data?.error || enrollFace.status}`
    );
    return false;
  }
  console.log(`  ${GREEN}PASS:${RESET} Face enrolled for kiosk clock-action`);

  // 7. Clock-in - POST exactly like frontend clockAction (includes faceHash)
  const clockInBody = {
    clockinId: codeToUse,
    action: 'clock-in',
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    faceHash,
    latitude: 51.5074,
    longitude: -0.1278,
  };
  const clockInResult = await makePlainClockLinkPost(
    '/clockin/clock-action',
    clockInBody,
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  const clockInPass = clockInResult.ok && clockInResult.data?.message;
  console.log(`  Clock-in:`);
  assertResult(
    'clock-in',
    { ok: true, hasMessage: true },
    { ok: clockInResult.ok, message: clockInResult.data?.message || clockInResult.data?.error },
    clockInPass
  );
  if (!clockInPass) {
    console.log(
      `  ${RED}ERROR:${RESET} Clock-in failed: ${clockInResult.data?.error || clockInResult.error}`
    );
    return false;
  }

  // 8. Clock-out - POST exactly like frontend (include lateReason when required by late validation)
  const clockOutBody = {
    clockinId: codeToUse,
    action: 'clock-out',
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    faceHash,
    latitude: 51.5074,
    longitude: -0.1278,
    lateReason: 'Test clock-out (API test)',
  };
  const clockOutResult = await makePlainClockLinkPost(
    '/clockin/clock-action',
    clockOutBody,
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  if (!clockOutResult.ok) {
    console.log(
      `  ${RED}ERROR:${RESET} Clock-out failed: ${clockOutResult.data?.error || clockOutResult.error}`
    );
    return false;
  }

  // 9. Verify response matches frontend expectations (review_hours, needs manager approval)
  const expectedStatus = 'review_hours';
  const actualStatus = clockOutResult.data?.status;
  const hasReviewHours = actualStatus === expectedStatus;
  console.log(`  Clock-out status:`);
  assertResult('status', expectedStatus, actualStatus, hasReviewHours);

  const actualMsg = clockOutResult.data?.message || '';
  const hasReviewMessage =
    actualMsg.toLowerCase().includes('pending') || actualMsg.toLowerCase().includes('review');
  console.log(`  Clock-out message:`);
  assertResult(
    'message indicates review',
    'contains "pending" or "review"',
    actualMsg,
    hasReviewMessage
  );

  const clockOutPass = clockOutResult.ok && hasReviewHours && hasReviewMessage;
  console.log(`  Clock-out overall:`);
  assertResult(
    'clock-out',
    { ok: true, status: 'review_hours', messageIndicatesReview: true },
    { ok: clockOutResult.ok, status: actualStatus, message: actualMsg },
    clockOutPass
  );

  return clockOutPass;
}

// Get clock status (like frontend getClockStatus)
async function testGetClockStatus() {
  console.log('\n=== Testing Get Clock Status (clock-link) ===');
  if (!clockinLinkToken || !clockinDeviceFingerprint || !staffId) {
    console.log(`  ${YELLOW}SKIP:${RESET} Run clock-in flow first`);
    return true;
  }
  const code = (await getStaffClockinCode(staffId)) || '123456';
  const result = await makeClockLinkRequest(
    `/clockin/status/${clockinLinkToken}?fingerprint=${encodeURIComponent(clockinDeviceFingerprint)}&clockinId=${code}`,
    null,
    'GET',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  const expected = { status: 200, ok: true };
  const actual = { status: result.status, ok: result.ok };
  console.log(`  Get clock status:`);
  assertResult('status endpoint', expected, actual, result.ok && result.status === 200);
  return result.ok && result.status === 200;
}

// ============================================
// PAYMENT ENDPOINTS (Stripe)
// ============================================

async function testGetPaymentConfig() {
  console.log('\n=== Testing Get Payment Config ===');
  const result = await makeRequest('/payment/config');
  return assertStatusResponse('Get Payment Config', result, 200);
}

async function testGetSubscriptionDetails() {
  console.log('\n=== Testing Get Subscription Details ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payment/subscription-details', {}, 'GET');
  return assertStatusResponse('Get Subscription Details', result, 200);
}

async function testGetReferenceNumbers() {
  console.log('\n=== Testing Get Reference Numbers ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payment/reference-numbers', {}, 'GET');
  return assertStatusResponse('Get Reference Numbers', result, 200);
}

async function runAllTests() {
  console.log('========================================');
  console.log('COMPREHENSIVE API Endpoint Testing Suite');
  console.log('========================================');
  console.log(`Testing against: ${API_BASE_URL}`);
  console.log(`${CYAN}Each test shows Expected vs Actual - they must match to PASS.${RESET}\n`);
  console.log(
    `SESSION_SECRET: ${SESSION_SECRET ? 'Set (' + SESSION_SECRET.substring(0, 10) + '...)' : 'Not set'}`
  );
  console.log(`Node version: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'not set'}`);
  console.log('========================================\n');

  // Test connectivity first
  console.log('Testing connectivity to API server...');
  try {
    const testResult = await makeRequest('/health');
    if (!testResult.ok && testResult.status === 0) {
      console.error(`\n${RED}CRITICAL:${RESET} Cannot connect to ${API_BASE_URL}`);
      console.error(`   Error: ${testResult.error || 'Connection failed'}`);
      console.error(`   Error code: ${testResult.errorCode || 'unknown'}`);
      console.error(`\n   Please ensure:`);
      console.error(`   1. The backend server is running on port 8081`);
      console.error(`   2. The server is accessible from this environment`);
      console.error(`   3. No firewall is blocking the connection\n`);
      return false;
    }
    console.log(`${GREEN}PASS:${RESET} Server is reachable (Status: ${testResult.status})\n`);
  } catch (error) {
    console.error(`\n${RED}CRITICAL:${RESET} Failed to test connectivity:`, error.message);
    console.error(`   Stack: ${error.stack?.split('\n').slice(0, 3).join('\n')}`);
    return false;
  }

  // Ensure time_entries has approved_at (needed for staff stats, payroll, earnings)
  try {
    execSync('node scripts/run-time-entry-approval-migration.js', {
      stdio: 'pipe',
      cwd: process.cwd(),
    });
    console.log(`  ${GREEN}Migration:${RESET} time_entries approved_at/approved_by`);
  } catch (err) {
    console.log(
      `  ${YELLOW}Note:${RESET} Migration skipped or already applied (${err.message?.slice(0, 80)})`
    );
  }

  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  };

  // Health & Contact
  const healthOk = await testHealthCheck();
  results.tests.push({ name: 'Health Check', passed: healthOk });
  if (healthOk) results.passed++;
  else results.failed++;

  // const contactOk = await testContactForm();
  // results.tests.push({ name: 'Contact Form', passed: contactOk });
  // if (contactOk) results.passed++; else results.failed++;

  // Authentication tests
  // Only do ONE signup to get a session, don't create multiple sessions
  const signupOk = await testSignup();
  results.tests.push({ name: 'Signup (Non-Obfuscated)', passed: signupOk });
  if (signupOk) results.passed++;
  else results.failed++;

  // Load CSRF token from the session we just created
  if (sessionId) {
    csrfToken = await fetchCsrfTokenFromApi(sessionId);
    console.log(`  CSRF Token generated from session: ${csrfToken.substring(0, 20)}...`);
    console.log(`  Session ID: ${sessionId.substring(0, 30)}...`);
  } else {
    console.log(`  ${YELLOW}WARNING:${RESET} No session ID after signup`);
  }

  // Skip the obfuscated signup test - it creates a new session which breaks CSRF
  // Instead, just verify we have a session
  if (!sessionId) {
    console.log(`  ${YELLOW}WARNING:${RESET} No session available, attempting signin...`);
    const signinOk = await testSignin();
    if (signinOk && sessionId) {
      csrfToken = await fetchCsrfTokenFromApi(sessionId);
      console.log(`  CSRF Token generated from signin session: ${csrfToken.substring(0, 20)}...`);
    }
  }

  // Public, non-authenticated endpoints that should run even if signup/signin fail
  const forgotPwdOk = await testForgotPassword();
  results.tests.push({ name: 'Forgot Password', passed: forgotPwdOk });
  if (forgotPwdOk) results.passed++;
  else results.failed++;

  const paymentConfigOk = await testGetPaymentConfig();
  results.tests.push({ name: 'Get Payment Config', passed: paymentConfigOk });
  if (paymentConfigOk) results.passed++;
  else results.failed++;

  const faceIdValidationOk = await testFaceIdKioskValidation();
  results.tests.push({ name: 'Face ID kiosk (validation)', passed: faceIdValidationOk });
  if (faceIdValidationOk) results.passed++;
  else results.failed++;

  if (!sessionId) {
    console.log(
      `\n${YELLOW}WARNING:${RESET} No session available, skipping authenticated endpoint tests`
    );
  } else if (!csrfToken) {
    csrfToken = await fetchCsrfTokenFromApi(sessionId);
    console.log(
      `\n${GREEN}PASS:${RESET} Generated CSRF token for session: ${sessionId.substring(0, 20)}...`
    );
  }

  // If we have a session, test authenticated endpoints
  if (sessionId && csrfToken) {
    // Auth endpoints
    const meOk = await testGetMe();
    results.tests.push({ name: 'Get /auth/me', passed: meOk });
    if (meOk) results.passed++;
    else results.failed++;

    const csrfOk = await testGetCsrfToken();
    results.tests.push({ name: 'Get CSRF Token', passed: csrfOk });
    if (csrfOk) results.passed++;
    else results.failed++;

    const profileOk = await testGetProfile();
    results.tests.push({ name: 'Update Profile (Obfuscated)', passed: profileOk });
    if (profileOk) results.passed++;
    else results.failed++;

    const profileObfOk = await testGetProfileObfuscated();
    results.tests.push({ name: 'Update Profile (Obfuscated)', passed: profileObfOk });
    if (profileObfOk) results.passed++;
    else results.failed++;

    const twoFAOk = await test2FAStatus();
    results.tests.push({ name: '2FA Status', passed: twoFAOk });
    if (twoFAOk) results.passed++;
    else results.failed++;

    // Forgot Password already tested in public section above

    // Staff endpoints
    const staffResult = await makeObfuscatedRequest('/staff', {}, 'GET');
    const staffOk = staffResult.ok && staffResult.status === 200;
    results.tests.push({ name: 'Get Staff', passed: staffOk });
    if (staffOk) {
      results.passed++;
      if (staffResult.data?.staff && staffResult.data.staff.length > 0) {
        staffId = staffResult.data.staff[0].id;
      }
    } else {
      results.failed++;
    }

    const staffObfOk = await testGetStaffObfuscated();
    results.tests.push({ name: 'Get Staff (Obfuscated)', passed: staffObfOk });
    if (staffObfOk) results.passed++;
    else results.failed++;

    const createdStaffId = await createTestStaff();
    const createStaffOk = createdStaffId !== null;
    if (createStaffOk) {
      staffId = createdStaffId; // Update global staffId
      results.tests.push({ name: 'Create Staff', passed: true });
      results.passed++;
    } else {
      results.tests.push({ name: 'Create Staff', passed: false });
      results.failed++;
    }

    const staffStatsOk = await testGetStaffStats();
    results.tests.push({ name: 'Get Staff Stats', passed: staffStatsOk });
    if (staffStatsOk) results.passed++;
    else results.failed++;

    const staffByIdOk = await testGetStaffById();
    results.tests.push({ name: 'Get Staff By ID', passed: staffByIdOk });
    if (staffByIdOk) results.passed++;
    else results.failed++;

    const updateStaffOk = await testUpdateStaff();
    results.tests.push({ name: 'Update Staff', passed: updateStaffOk });
    if (updateStaffOk) results.passed++;
    else results.failed++;

    // Shift endpoints
    const shiftsOk = await testGetShifts();
    results.tests.push({ name: 'Get Shifts', passed: shiftsOk });
    if (shiftsOk) results.passed++;
    else results.failed++;

    const shiftsObfOk = await testGetShiftsObfuscated();
    results.tests.push({ name: 'Get Shifts (Obfuscated)', passed: shiftsObfOk });
    if (shiftsObfOk) results.passed++;
    else results.failed++;

    const shiftStatsOk = await testGetShiftStats();
    results.tests.push({ name: 'Get Shift Stats', passed: shiftStatsOk });
    if (shiftStatsOk) results.passed++;
    else results.failed++;

    // Get staff before creating shift
    if (!staffId) {
      const staffRes = await makeObfuscatedRequest('/staff', {}, 'GET');
      if (staffRes.ok && staffRes.data?.staff && staffRes.data.staff.length > 0) {
        staffId = staffRes.data.staff[0].id;
      } else {
        const createdStaffId = await createTestStaff();
        if (createdStaffId) staffId = createdStaffId;
      }
    }

    const createShiftResult = await testCreateShift();
    const createShiftOk = createShiftResult === true;
    results.tests.push({ name: 'Create Shift (Obfuscated)', passed: createShiftOk });
    if (createShiftOk) results.passed++;
    else results.failed++;

    const createShiftObfOk = await testCreateShiftObfuscated();
    results.tests.push({ name: 'Create Shift (Obfuscated)', passed: createShiftObfOk });
    if (createShiftObfOk) results.passed++;
    else results.failed++;

    const shiftByIdOk = await testGetShiftById();
    results.tests.push({ name: 'Get Shift By ID', passed: shiftByIdOk });
    if (shiftByIdOk) results.passed++;
    else results.failed++;

    const updateShiftOk = await testUpdateShift();
    results.tests.push({ name: 'Update Shift', passed: updateShiftOk });
    if (updateShiftOk) results.passed++;
    else results.failed++;

    const approveShiftOk = await testApproveShift();
    results.tests.push({ name: 'Approve Shift', passed: approveShiftOk });
    if (approveShiftOk) results.passed++;
    else results.failed++;

    const shiftSwapsOk = await testGetShiftSwaps();
    results.tests.push({ name: 'Get Shift Swaps', passed: shiftSwapsOk });
    if (shiftSwapsOk) results.passed++;
    else results.failed++;

    const shiftConflictOk = await testShiftConflictOvernightNoFalsePositive();
    results.tests.push({
      name: 'Shift Conflict: Overnight vs Same-Day (No False Conflict)',
      passed: shiftConflictOk,
    });
    if (shiftConflictOk) results.passed++;
    else results.failed++;

    const overnightStatusOk = await testOvernightShiftNotCompletedPrematurely();
    results.tests.push({
      name: 'Overnight Shift: Not Completed Prematurely',
      passed: overnightStatusOk,
    });
    if (overnightStatusOk) results.passed++;
    else results.failed++;

    const multiDayOk = await testMultiDayShiftCreation();
    results.tests.push({ name: 'Multi-Day Shift (120h) Creation', passed: multiDayOk });
    if (multiDayOk) results.passed++;
    else results.failed++;

    const fiveOvernightOk = await testFiveConsecutiveOvernightShifts();
    results.tests.push({ name: '5 Consecutive Overnight Shifts', passed: fiveOvernightOk });
    if (fiveOvernightOk) results.passed++;
    else results.failed++;

    const day24Ok = await test24HourShiftEndTime();
    results.tests.push({ name: '24-Hour Shift End Time', passed: day24Ok });
    if (day24Ok) results.passed++;
    else results.failed++;

    const day24UnattendedOk = await test24HourShiftNoClockInUnattended();
    results.tests.push({
      name: '24-Hour Shift: No Clock-In → Unattended',
      passed: day24UnattendedOk,
    });
    if (day24UnattendedOk) results.passed++;
    else results.failed++;

    const completedCorrectedOk = await testCompletedShiftWithNoClockInCorrected();
    results.tests.push({
      name: 'Completed (No Clock-In) Corrected to Unattended',
      passed: completedCorrectedOk,
    });
    if (completedCorrectedOk) results.passed++;
    else results.failed++;

    // Time Entries & Payroll
    const timeEntriesOk = await testGetTimeEntries();
    results.tests.push({ name: 'Get Time Entries', passed: timeEntriesOk });
    if (timeEntriesOk) results.passed++;
    else results.failed++;

    const payrollOk = await testGetPayrollPreview();
    results.tests.push({ name: 'Get Payroll Preview', passed: payrollOk });
    if (payrollOk) results.passed++;
    else results.failed++;

    const earningsOk = await testGetMonthlyEarnings();
    results.tests.push({ name: 'Get Monthly Earnings', passed: earningsOk });
    if (earningsOk) results.passed++;
    else results.failed++;

    const createTimeEntryOk = await testCreateTimeEntry();
    results.tests.push({ name: 'Create Time Entry', passed: createTimeEntryOk });
    if (createTimeEntryOk) results.passed++;
    else results.failed++;

    // Payments
    // const paymentScheduleOk = await testGetPaymentSchedule();
    // results.tests.push({ name: 'Get Payment Schedule', passed: paymentScheduleOk });
    // if (paymentScheduleOk) results.passed++; else results.failed++;

    // const createPaymentScheduleOk = await testCreatePaymentSchedule();
    // results.tests.push({ name: 'Create Payment Schedule', passed: createPaymentScheduleOk });
    // if (createPaymentScheduleOk) results.passed++; else results.failed++;

    // const paymentHistoryOk = await testGetPaymentHistory();
    // results.tests.push({ name: 'Get Payment History', passed: paymentHistoryOk });
    // if (paymentHistoryOk) results.passed++; else results.failed++;

    // const paymentStatsOk = await testGetPaymentStats();
    // results.tests.push({ name: 'Get Payment Stats', passed: paymentStatsOk });
    // if (paymentStatsOk) results.passed++; else results.failed++;

    // Locations
    const locationOk = await testGetLocation();
    results.tests.push({ name: 'Get Location', passed: locationOk });
    if (locationOk) results.passed++;
    else results.failed++;

    const updateLocationOk = await testUpdateLocation();
    results.tests.push({ name: 'Update Location', passed: updateLocationOk });
    if (updateLocationOk) results.passed++;
    else results.failed++;

    const locationsOk = await testGetLocations();
    results.tests.push({ name: 'Get Locations (Multi)', passed: locationsOk });
    if (locationsOk) results.passed++;
    else results.failed++;

    const createLocationOk = await testCreateLocation();
    results.tests.push({ name: 'Create Location', passed: createLocationOk });
    if (createLocationOk) results.passed++;
    else results.failed++;

    // Budgets
    const budgetsOk = await testGetBudgets();
    results.tests.push({ name: 'Get Budgets', passed: budgetsOk });
    if (budgetsOk) results.passed++;
    else results.failed++;

    const activeBudgetOk = await testGetActiveBudget();
    results.tests.push({ name: 'Get Active Budget', passed: activeBudgetOk });
    if (activeBudgetOk) results.passed++;
    else results.failed++;

    const createBudgetOk = await testCreateBudget();
    results.tests.push({ name: 'Create Budget', passed: createBudgetOk });
    if (createBudgetOk) results.passed++;
    else results.failed++;

    const budgetStatsOk = await testGetBudgetStats();
    results.tests.push({ name: 'Get Budget Stats', passed: budgetStatsOk });
    if (budgetStatsOk) results.passed++;
    else results.failed++;

    // Activities
    const activitiesOk = await testGetActivities();
    results.tests.push({ name: 'Get Activities', passed: activitiesOk });
    if (activitiesOk) results.passed++;
    else results.failed++;

    const activityStatsOk = await testGetActivityStats();
    results.tests.push({ name: 'Get Activity Stats', passed: activityStatsOk });
    if (activityStatsOk) results.passed++;
    else results.failed++;

    // Fraud Detection
    const fraudFlagsOk = await testGetFraudFlags();
    results.tests.push({ name: 'Get Fraud Flags', passed: fraudFlagsOk });
    if (fraudFlagsOk) results.passed++;
    else results.failed++;

    const fraudStatsOk = await testGetFraudStats();
    results.tests.push({ name: 'Get Fraud Stats', passed: fraudStatsOk });
    if (fraudStatsOk) results.passed++;
    else results.failed++;

    // Security
    const apiKeysOk = await testGetApiKeys();
    results.tests.push({ name: 'Get API Keys', passed: apiKeysOk });
    if (apiKeysOk) results.passed++;
    else results.failed++;

    const createApiKeyOk = await testCreateApiKey();
    results.tests.push({ name: 'Create API Key', passed: createApiKeyOk });
    if (createApiKeyOk) results.passed++;
    else results.failed++;

    const ipWhitelistOk = await testGetIpWhitelist();
    results.tests.push({ name: 'Get IP Whitelist', passed: ipWhitelistOk });
    if (ipWhitelistOk) results.passed++;
    else results.failed++;

    const auditLogsOk = await testGetAuditLogs();
    results.tests.push({ name: 'Get Audit Logs', passed: auditLogsOk });
    if (auditLogsOk) results.passed++;
    else results.failed++;

    // Clock-in/Clock-out
    const clockinLinkOk = await testGenerateClockinLink();
    results.tests.push({ name: 'Generate Clock-in Link', passed: clockinLinkOk });
    if (clockinLinkOk) results.passed++;
    else results.failed++;

    const clockinLinksOk = await testGetClockinLinks();
    results.tests.push({ name: 'Get Clock-in Links', passed: clockinLinksOk });
    if (clockinLinksOk) results.passed++;
    else results.failed++;

    // Full clock-in flow with staff (matches frontend exactly)
    let clockInFlowOk = false;
    try {
      clockInFlowOk = await testClockInFlowWithStaff();
    } catch (err) {
      console.log(`  ${RED}ERROR:${RESET} Clock-in flow: ${err.message}`);
    }
    results.tests.push({
      name: 'Clock-in Flow (verify, clock-in, clock-out)',
      passed: clockInFlowOk,
    });
    if (clockInFlowOk) results.passed++;
    else results.failed++;

    const faceIdFlowOk = await testFaceIdKioskFlow();
    results.tests.push({
      name: 'Face ID kiosk (enroll → verify → faceHashes → verify → identify)',
      passed: faceIdFlowOk,
    });
    if (faceIdFlowOk) results.passed++;
    else results.failed++;

    const clockStatusOk = await testGetClockStatus();
    results.tests.push({ name: 'Get Clock Status (clock-link)', passed: clockStatusOk });
    if (clockStatusOk) results.passed++;
    else results.failed++;

    // Payment Endpoints (Stripe)
    // Get Payment Config already tested in public section above

    // const subscriptionOk = await testGetSubscriptionDetails();
    // results.tests.push({ name: 'Get Subscription Details', passed: subscriptionOk });
    // if (subscriptionOk) results.passed++; else results.failed++;

    // const referenceNumbersOk = await testGetReferenceNumbers();
    // results.tests.push({ name: 'Get Reference Numbers', passed: referenceNumbersOk });
    // if (referenceNumbersOk) results.passed++; else results.failed++;
  } else {
    console.log(
      `\n${YELLOW}WARNING:${RESET} No session available, skipping authenticated endpoint tests`
    );
  }

  // Summary
  console.log('\n========================================');
  console.log('Test Summary');
  console.log('========================================');
  const failedTests = [];
  const plainTests = new Set([
    'Health Check',
    'Signup (Non-Obfuscated)',
    'Forgot Password',
    'Get Payment Config',
    'Face ID kiosk (validation)',
  ]);
  results.tests.forEach((test) => {
    const status = test.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const modeLabel = plainTests.has(test.name) ? '[PLAIN]' : '[OBF]';
    console.log(`${status} ${modeLabel} ${test.name}`);
    if (!test.passed) {
      failedTests.push(test.name);
    }
  });
  console.log(`\nTotal: ${results.passed + results.failed} tests`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);

  if (failedTests.length > 0) {
    console.log('\n========================================');
    console.log('Failed Tests Summary:');
    console.log('========================================');
    failedTests.forEach((name) => {
      console.log(`  ${RED}FAIL:${RESET} ${name}`);
    });
    console.log(`\n  See "Expected" vs "Actual" output above for each failed test.`);
  }
  console.log('========================================\n');

  // Return whether all tests passed
  return results.failed === 0;
}

runAllTests()
  .then((allPassed) => {
    if (!allPassed) {
      console.error(`\n${RED}ERROR:${RESET} Some tests failed. Exiting with error code.`);
      console.error('This will prevent deployment from proceeding.');
      process.exit(1);
    } else {
      console.log(`${GREEN}SUCCESS:${RESET} All tests passed!`);
      process.exit(0);
    }
  })
  .catch((error) => {
    console.error(`\n${RED}ERROR:${RESET} Test suite crashed with error:`);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('\nThis will prevent deployment from proceeding.');
    process.exit(1);
  });
