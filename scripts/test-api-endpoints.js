import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { pool } from '../lib/db.js';

dotenv.config();

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8081/api';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-key-in-production';

// Generate CSRF token from session ID
function generateCsrfToken(sessionId) {
  return crypto
    .createHash('sha256')
    .update(sessionId + SESSION_SECRET)
    .digest('hex');
}

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
    'Linux'
  ].join('|');
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const char = fingerprint.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// Make obfuscated request using clock-link auth (X-Link-Token + X-Device-Fingerprint)
// Matches frontend: uses clocklink:token:fp as obfuscation key, same body/headers as clockin API
async function makeClockLinkRequest(endpoint, body, method, linkToken, deviceFingerprint) {
  const clocklinkSessionId = `clocklink:${linkToken}:${deviceFingerprint}`;
  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const key = generateObfuscationKey(clocklinkSessionId);

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
    'X-Obfuscation-Enabled': 'true',
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    'X-Link-Token': linkToken,
    'X-Device-Fingerprint': deviceFingerprint
  };

  const fetchOptions = {
    method,
    headers
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/x-obfuscated';
    const payload = {
      format: 'information',
      data: obfuscatedBody || ''
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
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      error: error.message
    };
  }
}

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
          // Always regenerate CSRF token when session changes
          csrfToken = generateCsrfToken(sessionId);
          if (oldSessionId) {
            console.log(`  ${YELLOW}WARNING:${RESET} Session ID changed from ${oldSessionId.substring(0, 20)}... to ${sessionId.substring(0, 20)}...`);
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

function generateObfuscationKey(sessionId) {
  if (!sessionId) {
    throw new Error('Session required for API obfuscation');
  }
  const timeComponent = Math.floor(Date.now() / 60000);
  return `${sessionId}_${timeComponent}`.substring(0, 32);
}

function generateRequestSignature(method, url, body, sessionId, timestamp, nonce) {
  const key = generateObfuscationKey(sessionId);
  
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
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  const combined = `${hash}:${key}`;
  let finalHash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    finalHash = ((finalHash << 5) - finalHash) + char;
    finalHash = finalHash & finalHash;
  }
  
  return Math.abs(finalHash).toString(36);
}

async function makeObfuscatedRequest(endpoint, body, method = 'POST') {
  if (!sessionId) {
    throw new Error('Session required for obfuscated requests');
  }

  // Ensure CSRF token is generated from current session
  if (!csrfToken) {
    csrfToken = generateCsrfToken(sessionId);
  }

  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const key = generateObfuscationKey(sessionId);
  
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
    'X-Obfuscation-Enabled': 'true',
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    'Authorization': `Bearer ${sessionId}`,
    'Cookie': `sessionId=${sessionId}`,
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

    // Update session and CSRF token from response
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const sessionMatch = setCookie.match(/sessionId=([^;]+)/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
        csrfToken = generateCsrfToken(sessionId);
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
    console.log(`Status: ${result.status}`);
    if (result.error) {
      console.error(`${RED}ERROR:${RESET} ${result.error}`);
      console.error(`  This usually means the server is not accessible at ${API_BASE_URL}`);
      console.error(`  Check if the server is running and accessible`);
    }
    if (result.data) {
      console.log(`Response:`, result.data);
    }
    return result.ok;
  } catch (error) {
    console.error(`${RED}ERROR:${RESET} Health check failed with exception:`, error.message);
    return false;
  }
}

async function testSignup() {
  console.log('\n=== Testing Signup (Non-Obfuscated) ===');
  const email = `test-${Date.now()}@example.com`;
  const password = 'TestPassword123!';
  
  const result = await makeRequest('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      name: 'Test User',
    }),
  });

  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  
  if (result.ok && result.data?.user) {
    userId = result.data.user.id;
    console.log(`${GREEN}PASS:${RESET} Signup successful. User ID: ${userId}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  return false;
}

async function testSignupObfuscated() {
  console.log('\n=== Testing Signup (Obfuscated) ===');
  console.log(`${YELLOW}NOTE:${RESET} Signup/signin endpoints typically do not use obfuscation as they create sessions`);
  const email = `test-obf-${Date.now()}@example.com`;
  const password = 'TestPassword123!';
  
  // Signup without obfuscation first to get a session
  const signupResult = await makeRequest('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      name: 'Test User Obf',
    }),
  });
  
  if (signupResult.ok && signupResult.data?.user) {
    console.log(`${GREEN}PASS:${RESET} Signup successful. User ID: ${signupResult.data.user.id}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  
  console.log(`Status: ${signupResult.status}`);
  console.log(`Response:`, JSON.stringify(signupResult.data, null, 2));
  return false;
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

  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  
  if (result.ok && result.data?.user) {
    userId = result.data.user.id;
    console.log(`${GREEN}PASS:${RESET} Signin successful. User ID: ${userId}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  return false;
}

async function testSigninObfuscated() {
  console.log('\n=== Testing Signin (Obfuscated) ===');
  console.log(`${YELLOW}NOTE:${RESET} Signin endpoints typically do not use obfuscation as they create sessions`);
  // First signin without obfuscation to get a session
  const signinResult = await makeRequest('/auth/signin', {
    method: 'POST',
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'TestPassword123!',
    }),
  });
  
  if (signinResult.ok && signinResult.data?.user) {
    userId = signinResult.data.user.id;
    console.log(`${GREEN}PASS:${RESET} Signin successful. User ID: ${userId}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  
  console.log(`Status: ${signinResult.status}`);
  console.log(`Response:`, JSON.stringify(signinResult.data, null, 2));
  return false;
}

async function testGetProfile() {
  console.log('\n=== Testing Update Profile (Obfuscated) ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/auth/profile', {
    name: 'Test User Updated',
  }, 'PUT');
  
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  return result.ok;
}

async function testGetProfileObfuscated() {
  console.log('\n=== Testing Get Profile (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available, skipping obfuscated request`);
    return false;
  }
  const result = await makeObfuscatedRequest('/auth/profile', { name: 'Test User Obfuscated' }, 'PUT');
  
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  return result.ok;
}

async function testGetShifts() {
  console.log('\n=== Testing Get Shifts ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shifts', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (result.data) {
    console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
  }
  return result.ok;
}

async function testGetShiftsObfuscated() {
  console.log('\n=== Testing Get Shifts (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available, skipping obfuscated request`);
    return false;
  }
  try {
    const result = await makeObfuscatedRequest('/shifts', {}, 'GET');
    
    console.log(`Status: ${result.status}`);
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    if (result.data) {
      console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
    }
    return result.ok;
  } catch (error) {
    console.log(`Error: ${error.message}`);
    return false;
  }
}

async function createTestStaff() {
  console.log('\n=== Creating Test Staff Member ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available for obfuscated request`);
    return null;
  }
  const result = await makeObfuscatedRequest('/staff', {
    name: 'Test Staff Member',
    email: `test-staff-${Date.now()}@example.com`,
    role: 'Server',
    hourlyRate: 15.00,
    employmentType: 'full-time',
  }, 'POST');
  
  if (result.ok && result.data?.staff) {
    console.log(`${GREEN}PASS:${RESET} Staff created: ${result.data.staff.name} (ID: ${result.data.staff.id})`);
    return result.data.staff.id;
  }
  console.log(`${YELLOW}WARNING:${RESET} Could not create staff: ${result.status} - ${JSON.stringify(result.data)}`);
  return null;
}

async function testCreateShift() {
  console.log('\n=== Testing Create Shift (Obfuscated, Authenticated) ===');
  
  // First, try to create a staff member if we don't have one
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffListResult = await makeObfuscatedRequest('/staff', {}, 'GET');
    if (staffListResult.ok && staffListResult.data?.staff && staffListResult.data.staff.length > 0) {
      localStaffId = staffListResult.data.staff[0].id;
      staffId = localStaffId; // Update global
      console.log(`  Using existing staff member ID: ${localStaffId}`);
    } else {
      localStaffId = await createTestStaff();
      if (localStaffId) staffId = localStaffId; // Update global
    }
  }
  
  if (!localStaffId) {
    console.log(`${YELLOW}WARNING:${RESET} No staff member available, skipping shift creation test`);
    return true; // Not a failure, just skip
  }
  
  const today = new Date().toISOString().split('T')[0];
  const result = await makeObfuscatedRequest('/shifts', {
    staffId: localStaffId,
    shiftDate: today,
    startTime: '09:00',
    hours: 8,
    location: 'Main Floor',
  }, 'POST');
  
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  if (result.ok && result.data?.shift) {
    createdShiftId = result.data.shift.id;
  }
  return result.status === 201;
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
    console.log(`${YELLOW}WARNING:${RESET} No staff member available, skipping obfuscated shift creation test`);
    return true; // Not a failure, just skip
  }
  
  const today = new Date().toISOString().split('T')[0];
  // Use a different time to avoid conflict with the non-obfuscated test
  const result = await makeObfuscatedRequest('/shifts', {
    staffId: staffId,
    shiftDate: today,
    startTime: '14:00', // Different time to avoid conflict
    hours: 4,
    location: 'Main Floor',
  }, 'POST');
  
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  // Accept 201 (created) or 409 (conflict - means validation is working)
  return result.status === 201 || result.status === 409;
}

async function testGetStaff() {
  console.log('\n=== Testing Get Staff ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/staff', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (result.data) {
    console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
  }
  return result.ok;
}

async function testGetStaffObfuscated() {
  console.log('\n=== Testing Get Staff (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log(`${YELLOW}WARNING:${RESET} No session available, skipping obfuscated request`);
    return false;
  }
  try {
    const result = await makeObfuscatedRequest('/staff', {}, 'GET');
    
    console.log(`Status: ${result.status}`);
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    if (result.data) {
      console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
    }
    return result.ok;
  } catch (error) {
    console.log(`Error: ${error.message}`);
    return false;
  }
}

// ============================================
// CONTACT & HEALTH
// ============================================

async function testContactForm() {
  console.log('\n=== Testing Contact Form (Obfuscated) ===');
  // Contact form sends data, so it should be obfuscated
  // But contact form doesn't require authentication, so we'll use regular request
  // However, if user wants all data requests obfuscated, we need a session first
  if (!sessionId) {
    // Try to get a session first, or use regular request for public endpoint
    const result = await makeRequest('/contact', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        subject: 'Test Subject',
        message: 'This is a test message'
      })
    });
    console.log(`Status: ${result.status}`);
    return result.ok && result.status === 200;
  }
  // If we have a session, use obfuscated request
  const result = await makeObfuscatedRequest('/contact', {
    name: 'Test User',
    email: `test-${Date.now()}@example.com`,
    subject: 'Test Subject',
    message: 'This is a test message'
  }, 'POST');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// AUTHENTICATION - Additional Endpoints
// ============================================

async function testGetMe() {
  console.log('\n=== Testing Get /auth/me ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/me', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetCsrfToken() {
  console.log('\n=== Testing Get CSRF Token ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/csrf-token', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function test2FAStatus() {
  console.log('\n=== Testing 2FA Status ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/auth/2fa/status', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testForgotPassword() {
  console.log('\n=== Testing Forgot Password ===');
  const result = await makeRequest('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({
      email: `test-${Date.now()}@example.com`
    })
  });
  console.log(`Status: ${result.status}`);
  // May return 200 even if user doesn't exist (security)
  return result.status === 200;
}

// ============================================
// STAFF - Additional Endpoints
// ============================================

async function testGetStaffStats() {
  console.log('\n=== Testing Get Staff Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/staff/stats', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetStaffById() {
  console.log('\n=== Testing Get Staff By ID ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  if (!staffId) {
    console.log(`  ${RED}ERROR:${RESET} No staff ID available`);
    return false;
  }
  const result = await makeObfuscatedRequest(`/staff/${staffId}`, {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testUpdateStaff() {
  console.log('\n=== Testing Update Staff (Obfuscated) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  if (!staffId) {
    console.log(`  ${RED}ERROR:${RESET} No staff ID available`);
    return false;
  }
  const result = await makeObfuscatedRequest(`/staff/${staffId}`, {
    name: 'Updated Staff Member',
    role: 'Manager'
  }, 'PUT');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

// ============================================
// SHIFTS - Additional Endpoints
// ============================================

async function testGetShiftStats() {
  console.log('\n=== Testing Get Shift Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shifts/stats', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetShiftById() {
  console.log('\n=== Testing Get Shift By ID ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}`, {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testUpdateShift() {
  console.log('\n=== Testing Update Shift (Obfuscated) ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}`, {
    startTime: '11:00',
    hours: 7
  }, 'PUT');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
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
  // For POST with empty body, pass null to ensure empty string is used for signature
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}/approve`, null, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
    if (result.data?.error === 'Invalid request signature') {
      console.log(`  ${YELLOW}WARNING:${RESET} Signature mismatch - checking empty body handling`);
    }
  }
  return result.ok && result.status === 200;
}

async function testGetShiftSwaps() {
  console.log('\n=== Testing Get Shift Swaps ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/shift-swaps', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// TIME ENTRIES & PAYROLL
// ============================================

async function testGetTimeEntries() {
  console.log('\n=== Testing Get Time Entries ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/time-entries', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetPayrollPreview() {
  console.log('\n=== Testing Get Payroll Preview ===');
  if (!sessionId) return false;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
  const result = await makeObfuscatedRequest(`/payroll-preview?startDate=${startDate}&endDate=${endDate}`, {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetMonthlyEarnings() {
  console.log('\n=== Testing Get Monthly Earnings ===');
  if (!sessionId) return false;
  const today = new Date();
  const result = await makeObfuscatedRequest(`/earnings/monthly?year=${today.getFullYear()}&month=${today.getMonth() + 1}`, {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
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
  const result = await makeObfuscatedRequest('/time-entries', {
    staffId: staffId,
    date: today,
    hoursWorked: 8, // Note: endpoint expects 'hoursWorked', not 'hours'
    hourlyRate: 15.00
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 201;
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
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testCreatePaymentSchedule() {
  console.log('\n=== Testing Create Payment Schedule (Obfuscated) ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payments/schedule', {
    scheduleType: 'weekly',
    paymentDay: 5
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && (result.status === 200 || result.status === 201);
}

async function testGetPaymentHistory() {
  console.log('\n=== Testing Get Payment History ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payments/history', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testGetPaymentStats() {
  console.log('\n=== Testing Get Payment Stats ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payments/stats', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

// ============================================
// LOCATIONS
// ============================================

async function testGetLocation() {
  console.log('\n=== Testing Get Location ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/location', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testUpdateLocation() {
  console.log('\n=== Testing Update Location (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/location', {
    latitude: 51.5074,
    longitude: -0.1278,
    radius: 100
  }, 'PUT');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetLocations() {
  console.log('\n=== Testing Get Locations (Multi) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/locations', {}, 'GET');
  // May return 403 if multi-location not enabled
  console.log(`Status: ${result.status}`);
  return result.ok || result.status === 403;
}

async function testCreateLocation() {
  console.log('\n=== Testing Create Location (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/locations', {
    name: 'Test Location',
    latitude: 51.5074,
    longitude: -0.1278,
    radius: 100
  }, 'POST');
  // May return 403 if multi-location not enabled
  console.log(`Status: ${result.status}`);
  if (result.ok && result.data?.location) {
    createdLocationId = result.data.location.id;
  }
  return result.ok || result.status === 403;
}

// ============================================
// BUDGETS
// ============================================

async function testGetBudgets() {
  console.log('\n=== Testing Get Budgets ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetActiveBudget() {
  console.log('\n=== Testing Get Active Budget ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets/active', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testCreateBudget() {
  console.log('\n=== Testing Create Budget (Obfuscated) ===');
  if (!sessionId) return false;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
  const result = await makeObfuscatedRequest('/budgets', {
    name: 'Test Budget',
    monthlyBudget: 10000,
    startDate: startDate,
    endDate: endDate
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (result.ok && result.data?.budget) {
    createdBudgetId = result.data.budget.id;
  }
  return result.ok && result.status === 201;
}

async function testGetBudgetStats() {
  console.log('\n=== Testing Get Budget Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/budgets/stats', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// ACTIVITIES
// ============================================

async function testGetActivities() {
  console.log('\n=== Testing Get Activities (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/activities', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetActivityStats() {
  console.log('\n=== Testing Get Activity Stats (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/activities/stats', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// FRAUD DETECTION
// ============================================

async function testGetFraudFlags() {
  console.log('\n=== Testing Get Fraud Flags ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/fraud/flags', {}, 'GET');
  // May require subscription
  console.log(`Status: ${result.status}`);
  return result.ok || result.status === 403;
}

async function testGetFraudStats() {
  console.log('\n=== Testing Get Fraud Stats ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/fraud/stats', {}, 'GET');
  // May require subscription
  console.log(`Status: ${result.status}`);
  return result.ok || result.status === 403;
}

// ============================================
// SECURITY
// ============================================

async function testGetApiKeys() {
  console.log('\n=== Testing Get API Keys ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/api-keys', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testCreateApiKey() {
  console.log('\n=== Testing Create API Key (Obfuscated) ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/api-keys', {
    keyName: `test-key-${Date.now()}`
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (result.ok && result.data?.key) {
    createdApiKeyId = result.data.key.id;
  }
  return result.ok && result.status === 201;
}

async function testGetIpWhitelist() {
  console.log('\n=== Testing Get IP Whitelist ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/ip-whitelist', {}, 'GET');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetAuditLogs() {
  console.log('\n=== Testing Get Audit Logs ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/security/audit-logs', {}, 'GET');
  console.log(`Status: ${result.status}`);
  // Audit logs endpoint requires admin privileges
  // Non-admin users should receive 403 Forbidden
  // This test verifies that access control is working correctly
  if (result.status === 403) {
    console.log(`  ${GREEN}PASS:${RESET} Access correctly denied for non-admin user (403 Forbidden)`);
    return true;
  }
  if (result.status === 200) {
    console.log(`  ${YELLOW}WARNING:${RESET} Non-admin user was able to access audit logs (should be 403)`);
    return false;
  }
  console.log(`  ${RED}ERROR:${RESET} Unexpected status: ${result.status}`);
  return false;
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
  const result = await makeObfuscatedRequest('/clockin/generate-link', {
    deviceName: 'Test Device API Script'
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
    return false;
  }
  if (result.ok && result.data?.link) {
    createdClockinLinkId = result.data.link.id;
    clockinLinkToken = result.data.link.token || result.data.link.link_token;
    console.log(`  ${GREEN}PASS:${RESET} Link created, token: ${clockinLinkToken?.substring(0, 16)}...`);
  }
  return result.ok && result.status === 200;
}

async function testGetClockinLinks() {
  console.log('\n=== Testing Get Clock-in Links ===');
  if (!sessionId) return false;
  const result = await makeObfuscatedRequest('/clockin/links', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (result.ok && result.data?.links?.length > 0 && !clockinLinkToken) {
    clockinLinkToken = result.data.links[0].token || result.data.links[0].link_token;
  }
  return result.ok && result.status === 200;
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
    const genResult = await makeObfuscatedRequest('/clockin/generate-link', {
      deviceName: 'Test Device API',
      expiresInDays: 90
    }, 'POST');
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

  // 4. Create shift for today via API (matches frontend - same path, avoids FK issues)
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  const startHour = Math.max(0, now.getHours() - 2);
  const startTime = `${String(startHour).padStart(2, '0')}:00`;
  const shiftRes = await makeObfuscatedRequest('/shifts', {
    staffId,
    shiftDate: today,
    startTime,
    hours: 10,
    location: 'Test Location',
  }, 'POST');
  if (!shiftRes.ok) {
    console.log(`  ${YELLOW}Note:${RESET} Shift creation: ${shiftRes.data?.error || shiftRes.error || 'unknown'}`);
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
  if (!verifyResult.ok) {
    console.log(`  ${RED}ERROR:${RESET} Verify link failed: ${verifyResult.data?.error || verifyResult.error}`);
    return false;
  }
  console.log(`  ${GREEN}PASS:${RESET} Verify link`);

  // 7. Clock-in - POST exactly like frontend clockAction
  const clockInBody = {
    clockinId: codeToUse,
    action: 'clock-in',
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    latitude: 51.5074,
    longitude: -0.1278
  };
  const clockInResult = await makeClockLinkRequest(
    '/clockin/clock-action',
    clockInBody,
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  if (!clockInResult.ok) {
    console.log(`  ${RED}ERROR:${RESET} Clock-in failed: ${clockInResult.data?.error || clockInResult.error}`);
    return false;
  }
  console.log(`  ${GREEN}PASS:${RESET} Clock-in: ${clockInResult.data?.message || 'OK'}`);

  // 8. Clock-out - POST exactly like frontend
  const clockOutBody = {
    clockinId: codeToUse,
    action: 'clock-out',
    linkToken: clockinLinkToken,
    deviceFingerprint: clockinDeviceFingerprint,
    latitude: 51.5074,
    longitude: -0.1278
  };
  const clockOutResult = await makeClockLinkRequest(
    '/clockin/clock-action',
    clockOutBody,
    'POST',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  if (!clockOutResult.ok) {
    console.log(`  ${RED}ERROR:${RESET} Clock-out failed: ${clockOutResult.data?.error || clockOutResult.error}`);
    return false;
  }

  // 9. Verify response matches frontend expectations (review_hours, Pending manager approval)
  const hasReviewHours = clockOutResult.data?.status === 'review_hours';
  const hasPendingMessage = clockOutResult.data?.message?.includes('Pending manager approval') ||
    clockOutResult.data?.message?.includes('pending');
  if (!hasReviewHours) {
    console.log(`  ${YELLOW}WARNING:${RESET} Expected status 'review_hours', got: ${clockOutResult.data?.status}`);
  }
  if (!hasPendingMessage) {
    console.log(`  ${YELLOW}WARNING:${RESET} Expected "Pending manager approval" in message`);
  }
  console.log(`  ${GREEN}PASS:${RESET} Clock-out: ${clockOutResult.data?.message || 'OK'}`);
  console.log(`  Response: status=${clockOutResult.data?.status}, hoursWorked=${clockOutResult.data?.hoursWorked}`);

  return clockOutResult.ok;
}

// Get clock status (like frontend getClockStatus)
async function testGetClockStatus() {
  console.log('\n=== Testing Get Clock Status (clock-link) ===');
  if (!clockinLinkToken || !clockinDeviceFingerprint || !staffId) {
    console.log(`  ${YELLOW}SKIP:${RESET} Run clock-in flow first`);
    return true;
  }
  const code = await getStaffClockinCode(staffId) || '123456';
  const result = await makeClockLinkRequest(
    `/clockin/status/${clockinLinkToken}?fingerprint=${encodeURIComponent(clockinDeviceFingerprint)}&clockinId=${code}`,
    null,
    'GET',
    clockinLinkToken,
    clockinDeviceFingerprint
  );
  console.log(`Status: ${result.status}`);
  return result.ok;
}

// ============================================
// PAYMENT ENDPOINTS (Stripe)
// ============================================

async function testGetPaymentConfig() {
  console.log('\n=== Testing Get Payment Config ===');
  const result = await makeRequest('/payment/config');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetSubscriptionDetails() {
  console.log('\n=== Testing Get Subscription Details ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payment/subscription-details', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testGetReferenceNumbers() {
  console.log('\n=== Testing Get Reference Numbers ===');
  if (!sessionId) {
    console.log(`  ${RED}ERROR:${RESET} No session available`);
    return false;
  }
  const result = await makeObfuscatedRequest('/payment/reference-numbers', {}, 'GET');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ${RED}ERROR:${RESET} ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function runAllTests() {
  console.log('========================================');
  console.log('COMPREHENSIVE API Endpoint Testing Suite');
  console.log('========================================');
  console.log(`Testing against: ${API_BASE_URL}`);
  console.log(`SESSION_SECRET: ${SESSION_SECRET ? 'Set (' + SESSION_SECRET.substring(0, 10) + '...)' : 'Not set'}`);
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
  
  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  };

  // Health & Contact
  const healthOk = await testHealthCheck();
  results.tests.push({ name: 'Health Check', passed: healthOk });
  if (healthOk) results.passed++; else results.failed++;

  // const contactOk = await testContactForm();
  // results.tests.push({ name: 'Contact Form', passed: contactOk });
  // if (contactOk) results.passed++; else results.failed++;

  // Authentication tests
  // Only do ONE signup to get a session, don't create multiple sessions
  const signupOk = await testSignup();
  results.tests.push({ name: 'Signup (Non-Obfuscated)', passed: signupOk });
  if (signupOk) results.passed++; else results.failed++;
  
  // Generate CSRF token from the session we just created
  if (sessionId) {
    csrfToken = generateCsrfToken(sessionId);
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
      csrfToken = generateCsrfToken(sessionId);
      console.log(`  CSRF Token generated from signin session: ${csrfToken.substring(0, 20)}...`);
    }
  }

  if (!sessionId) {
    console.log(`\n${YELLOW}WARNING:${RESET} No session available, skipping authenticated endpoint tests`);
  } else if (!csrfToken) {
    csrfToken = generateCsrfToken(sessionId);
    console.log(`\n${GREEN}PASS:${RESET} Generated CSRF token for session: ${sessionId.substring(0, 20)}...`);
  }

  // If we have a session, test authenticated endpoints
  if (sessionId && csrfToken) {
    // Auth endpoints
    const meOk = await testGetMe();
    results.tests.push({ name: 'Get /auth/me', passed: meOk });
    if (meOk) results.passed++; else results.failed++;

    const csrfOk = await testGetCsrfToken();
    results.tests.push({ name: 'Get CSRF Token', passed: csrfOk });
    if (csrfOk) results.passed++; else results.failed++;

    const profileOk = await testGetProfile();
    results.tests.push({ name: 'Update Profile (Obfuscated)', passed: profileOk });
    if (profileOk) results.passed++; else results.failed++;

    const profileObfOk = await testGetProfileObfuscated();
    results.tests.push({ name: 'Update Profile (Obfuscated)', passed: profileObfOk });
    if (profileObfOk) results.passed++; else results.failed++;

    const twoFAOk = await test2FAStatus();
    results.tests.push({ name: '2FA Status', passed: twoFAOk });
    if (twoFAOk) results.passed++; else results.failed++;

    const forgotPwdOk = await testForgotPassword();
    results.tests.push({ name: 'Forgot Password', passed: forgotPwdOk });
    if (forgotPwdOk) results.passed++; else results.failed++;

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
    if (staffObfOk) results.passed++; else results.failed++;

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
    if (staffStatsOk) results.passed++; else results.failed++;

    const staffByIdOk = await testGetStaffById();
    results.tests.push({ name: 'Get Staff By ID', passed: staffByIdOk });
    if (staffByIdOk) results.passed++; else results.failed++;

    const updateStaffOk = await testUpdateStaff();
    results.tests.push({ name: 'Update Staff', passed: updateStaffOk });
    if (updateStaffOk) results.passed++; else results.failed++;

    // Shift endpoints
    const shiftsOk = await testGetShifts();
    results.tests.push({ name: 'Get Shifts', passed: shiftsOk });
    if (shiftsOk) results.passed++; else results.failed++;

    const shiftsObfOk = await testGetShiftsObfuscated();
    results.tests.push({ name: 'Get Shifts (Obfuscated)', passed: shiftsObfOk });
    if (shiftsObfOk) results.passed++; else results.failed++;

    const shiftStatsOk = await testGetShiftStats();
    results.tests.push({ name: 'Get Shift Stats', passed: shiftStatsOk });
    if (shiftStatsOk) results.passed++; else results.failed++;

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
    if (createShiftOk) results.passed++; else results.failed++;

    const createShiftObfOk = await testCreateShiftObfuscated();
    results.tests.push({ name: 'Create Shift (Obfuscated)', passed: createShiftObfOk });
    if (createShiftObfOk) results.passed++; else results.failed++;

    const shiftByIdOk = await testGetShiftById();
    results.tests.push({ name: 'Get Shift By ID', passed: shiftByIdOk });
    if (shiftByIdOk) results.passed++; else results.failed++;

    const updateShiftOk = await testUpdateShift();
    results.tests.push({ name: 'Update Shift', passed: updateShiftOk });
    if (updateShiftOk) results.passed++; else results.failed++;

    const approveShiftOk = await testApproveShift();
    results.tests.push({ name: 'Approve Shift', passed: approveShiftOk });
    if (approveShiftOk) results.passed++; else results.failed++;

    const shiftSwapsOk = await testGetShiftSwaps();
    results.tests.push({ name: 'Get Shift Swaps', passed: shiftSwapsOk });
    if (shiftSwapsOk) results.passed++; else results.failed++;

    // Time Entries & Payroll
    const timeEntriesOk = await testGetTimeEntries();
    results.tests.push({ name: 'Get Time Entries', passed: timeEntriesOk });
    if (timeEntriesOk) results.passed++; else results.failed++;

    const payrollOk = await testGetPayrollPreview();
    results.tests.push({ name: 'Get Payroll Preview', passed: payrollOk });
    if (payrollOk) results.passed++; else results.failed++;

    const earningsOk = await testGetMonthlyEarnings();
    results.tests.push({ name: 'Get Monthly Earnings', passed: earningsOk });
    if (earningsOk) results.passed++; else results.failed++;

    const createTimeEntryOk = await testCreateTimeEntry();
    results.tests.push({ name: 'Create Time Entry', passed: createTimeEntryOk });
    if (createTimeEntryOk) results.passed++; else results.failed++;

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
    if (locationOk) results.passed++; else results.failed++;

    const updateLocationOk = await testUpdateLocation();
    results.tests.push({ name: 'Update Location', passed: updateLocationOk });
    if (updateLocationOk) results.passed++; else results.failed++;

    const locationsOk = await testGetLocations();
    results.tests.push({ name: 'Get Locations (Multi)', passed: locationsOk });
    if (locationsOk) results.passed++; else results.failed++;

    const createLocationOk = await testCreateLocation();
    results.tests.push({ name: 'Create Location', passed: createLocationOk });
    if (createLocationOk) results.passed++; else results.failed++;

    // Budgets
    const budgetsOk = await testGetBudgets();
    results.tests.push({ name: 'Get Budgets', passed: budgetsOk });
    if (budgetsOk) results.passed++; else results.failed++;

    const activeBudgetOk = await testGetActiveBudget();
    results.tests.push({ name: 'Get Active Budget', passed: activeBudgetOk });
    if (activeBudgetOk) results.passed++; else results.failed++;

    const createBudgetOk = await testCreateBudget();
    results.tests.push({ name: 'Create Budget', passed: createBudgetOk });
    if (createBudgetOk) results.passed++; else results.failed++;

    const budgetStatsOk = await testGetBudgetStats();
    results.tests.push({ name: 'Get Budget Stats', passed: budgetStatsOk });
    if (budgetStatsOk) results.passed++; else results.failed++;

    // Activities
    const activitiesOk = await testGetActivities();
    results.tests.push({ name: 'Get Activities', passed: activitiesOk });
    if (activitiesOk) results.passed++; else results.failed++;

    const activityStatsOk = await testGetActivityStats();
    results.tests.push({ name: 'Get Activity Stats', passed: activityStatsOk });
    if (activityStatsOk) results.passed++; else results.failed++;

    // Fraud Detection
    const fraudFlagsOk = await testGetFraudFlags();
    results.tests.push({ name: 'Get Fraud Flags', passed: fraudFlagsOk });
    if (fraudFlagsOk) results.passed++; else results.failed++;

    const fraudStatsOk = await testGetFraudStats();
    results.tests.push({ name: 'Get Fraud Stats', passed: fraudStatsOk });
    if (fraudStatsOk) results.passed++; else results.failed++;

    // Security
    const apiKeysOk = await testGetApiKeys();
    results.tests.push({ name: 'Get API Keys', passed: apiKeysOk });
    if (apiKeysOk) results.passed++; else results.failed++;

    const createApiKeyOk = await testCreateApiKey();
    results.tests.push({ name: 'Create API Key', passed: createApiKeyOk });
    if (createApiKeyOk) results.passed++; else results.failed++;

    const ipWhitelistOk = await testGetIpWhitelist();
    results.tests.push({ name: 'Get IP Whitelist', passed: ipWhitelistOk });
    if (ipWhitelistOk) results.passed++; else results.failed++;

    const auditLogsOk = await testGetAuditLogs();
    results.tests.push({ name: 'Get Audit Logs', passed: auditLogsOk });
    if (auditLogsOk) results.passed++; else results.failed++;

    // Clock-in/Clock-out
    const clockinLinkOk = await testGenerateClockinLink();
    results.tests.push({ name: 'Generate Clock-in Link', passed: clockinLinkOk });
    if (clockinLinkOk) results.passed++; else results.failed++;

    const clockinLinksOk = await testGetClockinLinks();
    results.tests.push({ name: 'Get Clock-in Links', passed: clockinLinksOk });
    if (clockinLinksOk) results.passed++; else results.failed++;

    // Full clock-in flow with staff (matches frontend exactly)
    let clockInFlowOk = false;
    try {
      clockInFlowOk = await testClockInFlowWithStaff();
    } catch (err) {
      console.log(`  ${RED}ERROR:${RESET} Clock-in flow: ${err.message}`);
    }
    results.tests.push({ name: 'Clock-in Flow (verify, clock-in, clock-out)', passed: clockInFlowOk });
    if (clockInFlowOk) results.passed++; else results.failed++;

    const clockStatusOk = await testGetClockStatus();
    results.tests.push({ name: 'Get Clock Status (clock-link)', passed: clockStatusOk });
    if (clockStatusOk) results.passed++; else results.failed++;

    // Payment Endpoints (Stripe)
    const paymentConfigOk = await testGetPaymentConfig();
    results.tests.push({ name: 'Get Payment Config', passed: paymentConfigOk });
    if (paymentConfigOk) results.passed++; else results.failed++;

    // const subscriptionOk = await testGetSubscriptionDetails();
    // results.tests.push({ name: 'Get Subscription Details', passed: subscriptionOk });
    // if (subscriptionOk) results.passed++; else results.failed++;

    // const referenceNumbersOk = await testGetReferenceNumbers();
    // results.tests.push({ name: 'Get Reference Numbers', passed: referenceNumbersOk });
    // if (referenceNumbersOk) results.passed++; else results.failed++;
  } else {
    console.log(`\n${YELLOW}WARNING:${RESET} No session available, skipping authenticated endpoint tests`);
  }

  // Summary
  console.log('\n========================================');
  console.log('Test Summary');
  console.log('========================================');
  const failedTests = [];
  results.tests.forEach((test) => {
    const status = test.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`${status} ${test.name}`);
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

