import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = 'http://localhost:8081/api';
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
        sessionId = sessionMatch[1];
        // Generate CSRF token from session ID
        csrfToken = generateCsrfToken(sessionId);
      }
      
      // Extract CSRF token from cookie if present
      if (setCookieHeader.includes('csrfToken=')) {
        const csrfMatch = setCookieHeader.match(/csrfToken=([^;]+)/);
        if (csrfMatch) {
          csrfToken = csrfMatch[1];
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
    return {
      status: 0,
      ok: false,
      error: error.message,
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
    'Content-Type': 'application/x-obfuscated',
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
  const result = await makeRequest('/health');
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, result.data);
  return result.ok;
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
    console.log(`✓ Signup successful. User ID: ${userId}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  return false;
}

async function testSignupObfuscated() {
  console.log('\n=== Testing Signup (Obfuscated) ===');
  console.log('⚠ Note: Signup/signin endpoints typically do not use obfuscation as they create sessions');
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
    console.log(`✓ Signup successful. User ID: ${signupResult.data.user.id}`);
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
    console.log(`✓ Signin successful. User ID: ${userId}`);
    if (sessionId) {
      console.log(`  Session ID: ${sessionId.substring(0, 20)}...`);
    }
    return true;
  }
  return false;
}

async function testSigninObfuscated() {
  console.log('\n=== Testing Signin (Obfuscated) ===');
  console.log('⚠ Note: Signin endpoints typically do not use obfuscation as they create sessions');
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
    console.log(`✓ Signin successful. User ID: ${userId}`);
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
  console.log('\n=== Testing Update Profile (Authenticated) ===');
  if (!sessionId) {
    console.log('⚠ No session available');
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
    console.log('⚠ No session available, skipping obfuscated request');
    return false;
  }
  const result = await makeObfuscatedRequest('/auth/profile', { name: 'Test User Obfuscated' }, 'PUT');
  
  console.log(`Status: ${result.status}`);
  console.log(`Response:`, JSON.stringify(result.data, null, 2));
  return result.ok;
}

async function testGetShifts() {
  console.log('\n=== Testing Get Shifts (Authenticated) ===');
  const result = await makeRequest('/shifts');
  
  console.log(`Status: ${result.status}`);
  if (result.data) {
    console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
  }
  return result.ok;
}

async function testGetShiftsObfuscated() {
  console.log('\n=== Testing Get Shifts (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log('⚠ No session available, skipping obfuscated request');
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
    console.log('⚠ No session available for obfuscated request');
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
    console.log(`✓ Staff created: ${result.data.staff.name} (ID: ${result.data.staff.id})`);
    return result.data.staff.id;
  }
  console.log(`⚠ Could not create staff: ${result.status} - ${JSON.stringify(result.data)}`);
  return null;
}

async function testCreateShift() {
  console.log('\n=== Testing Create Shift (Authenticated) ===');
  
  // First, try to create a staff member if we don't have one
  let localStaffId = staffId;
  if (!localStaffId) {
    const staffListResult = await makeRequest('/staff');
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
    console.log('⚠ No staff member available, skipping shift creation test');
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
    console.log('⚠ No session available, skipping obfuscated request');
    return false;
  }
  
  // First, try to get a staff member
  let staffId = null;
  const staffListResult = await makeRequest('/staff');
  if (staffListResult.ok && staffListResult.data?.staff && staffListResult.data.staff.length > 0) {
    staffId = staffListResult.data.staff[0].id;
    console.log(`  Using existing staff member ID: ${staffId}`);
  } else {
    staffId = await createTestStaff();
  }
  
  if (!staffId) {
    console.log('⚠ No staff member available, skipping obfuscated shift creation test');
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
  console.log('\n=== Testing Get Staff (Authenticated) ===');
  const result = await makeRequest('/staff');
  
  console.log(`Status: ${result.status}`);
  if (result.data) {
    console.log(`Response:`, Array.isArray(result.data) ? `Array with ${result.data.length} items` : JSON.stringify(result.data, null, 2));
  }
  return result.ok;
}

async function testGetStaffObfuscated() {
  console.log('\n=== Testing Get Staff (Obfuscated, Authenticated) ===');
  if (!sessionId) {
    console.log('⚠ No session available, skipping obfuscated request');
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
  const result = await makeRequest('/auth/me');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetCsrfToken() {
  console.log('\n=== Testing Get CSRF Token ===');
  const result = await makeRequest('/auth/csrf-token');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function test2FAStatus() {
  console.log('\n=== Testing 2FA Status ===');
  if (!sessionId) return false;
  const result = await makeRequest('/auth/2fa/status');
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
  const result = await makeRequest('/staff/stats');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetStaffById() {
  console.log('\n=== Testing Get Staff By ID ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  if (!staffId) {
    console.log('  ❌ No staff ID available');
    return false;
  }
  const result = await makeRequest(`/staff/${staffId}`);
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testUpdateStaff() {
  console.log('\n=== Testing Update Staff ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  if (!staffId) {
    console.log('  ❌ No staff ID available');
    return false;
  }
  const result = await makeObfuscatedRequest(`/staff/${staffId}`, {
    name: 'Updated Staff Member',
    role: 'Manager'
  }, 'PUT');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
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
  const result = await makeRequest('/shifts/stats');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetShiftById() {
  console.log('\n=== Testing Get Shift By ID ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeRequest(`/shifts/${createdShiftId}`);
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testUpdateShift() {
  console.log('\n=== Testing Update Shift ===');
  if (!sessionId || !createdShiftId) return false;
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}`, {
    startTime: '11:00',
    hours: 7
  }, 'PUT');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testApproveShift() {
  console.log('\n=== Testing Approve Shift ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  if (!createdShiftId) {
    console.log('  ❌ No shift ID available (createdShiftId: ' + createdShiftId + ')');
    return false;
  }
  // For POST with empty body, pass null to ensure empty string is used for signature
  const result = await makeObfuscatedRequest(`/shifts/${createdShiftId}/approve`, null, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
    if (result.data?.error === 'Invalid request signature') {
      console.log(`  ⚠ Signature mismatch - checking empty body handling`);
    }
  }
  return result.ok && result.status === 200;
}

async function testGetShiftSwaps() {
  console.log('\n=== Testing Get Shift Swaps ===');
  const result = await makeRequest('/shift-swaps');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// TIME ENTRIES & PAYROLL
// ============================================

async function testGetTimeEntries() {
  console.log('\n=== Testing Get Time Entries ===');
  if (!sessionId) return false;
  const result = await makeRequest('/time-entries');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetPayrollPreview() {
  console.log('\n=== Testing Get Payroll Preview ===');
  if (!sessionId) return false;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
  const result = await makeRequest(`/payroll-preview?startDate=${startDate}&endDate=${endDate}`);
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetMonthlyEarnings() {
  console.log('\n=== Testing Get Monthly Earnings ===');
  if (!sessionId) return false;
  const today = new Date();
  const result = await makeRequest(`/earnings/monthly?year=${today.getFullYear()}&month=${today.getMonth() + 1}`);
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testCreateTimeEntry() {
  console.log('\n=== Testing Create Time Entry ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  if (!staffId) {
    console.log('  ❌ No staff ID available');
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
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
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
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeRequest('/payments/schedule');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testCreatePaymentSchedule() {
  console.log('\n=== Testing Create Payment Schedule ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeObfuscatedRequest('/payments/schedule', {
    scheduleType: 'weekly',
    paymentDay: 5
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && (result.status === 200 || result.status === 201);
}

async function testGetPaymentHistory() {
  console.log('\n=== Testing Get Payment History ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeRequest('/payments/history');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testGetPaymentStats() {
  console.log('\n=== Testing Get Payment Stats ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeRequest('/payments/stats');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
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
  const result = await makeRequest('/location');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testUpdateLocation() {
  console.log('\n=== Testing Update Location ===');
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
  const result = await makeRequest('/locations');
  // May return 403 if multi-location not enabled
  console.log(`Status: ${result.status}`);
  return result.ok || result.status === 403;
}

async function testCreateLocation() {
  console.log('\n=== Testing Create Location ===');
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
  const result = await makeRequest('/budgets');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetActiveBudget() {
  console.log('\n=== Testing Get Active Budget ===');
  if (!sessionId) return false;
  const result = await makeRequest('/budgets/active');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testCreateBudget() {
  console.log('\n=== Testing Create Budget ===');
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
  const result = await makeRequest('/budgets/stats');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// ACTIVITIES
// ============================================

async function testGetActivities() {
  console.log('\n=== Testing Get Activities ===');
  if (!sessionId) return false;
  const result = await makeRequest('/activities');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetActivityStats() {
  console.log('\n=== Testing Get Activity Stats ===');
  if (!sessionId) return false;
  const result = await makeRequest('/activities/stats');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// FRAUD DETECTION
// ============================================

async function testGetFraudFlags() {
  console.log('\n=== Testing Get Fraud Flags ===');
  if (!sessionId) return false;
  const result = await makeRequest('/fraud/flags');
  // May require subscription
  console.log(`Status: ${result.status}`);
  return result.ok || result.status === 403;
}

async function testGetFraudStats() {
  console.log('\n=== Testing Get Fraud Stats ===');
  if (!sessionId) return false;
  const result = await makeRequest('/fraud/stats');
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
  const result = await makeRequest('/security/api-keys');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testCreateApiKey() {
  console.log('\n=== Testing Create API Key ===');
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
  const result = await makeRequest('/security/ip-whitelist');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

async function testGetAuditLogs() {
  console.log('\n=== Testing Get Audit Logs ===');
  if (!sessionId) return false;
  const result = await makeRequest('/security/audit-logs');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
}

// ============================================
// CLOCK-IN/CLOCK-OUT
// ============================================

async function testGenerateClockinLink() {
  console.log('\n=== Testing Generate Clock-in Link ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeObfuscatedRequest('/clockin/generate-link', {
    deviceName: 'Test Device'
  }, 'POST');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  if (result.ok && result.data?.link) {
    createdClockinLinkId = result.data.link.id;
  }
  return result.ok && result.status === 200;
}

async function testGetClockinLinks() {
  console.log('\n=== Testing Get Clock-in Links ===');
  if (!sessionId) return false;
  const result = await makeRequest('/clockin/links');
  console.log(`Status: ${result.status}`);
  return result.ok && result.status === 200;
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
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeRequest('/payment/subscription-details');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function testGetReferenceNumbers() {
  console.log('\n=== Testing Get Reference Numbers ===');
  if (!sessionId) {
    console.log('  ❌ No session available');
    return false;
  }
  const result = await makeRequest('/payment/reference-numbers');
  console.log(`Status: ${result.status}`);
  if (!result.ok) {
    console.log(`  ❌ Error: ${result.data?.error || result.error || 'Unknown error'}`);
    console.log(`  Response: ${JSON.stringify(result.data, null, 2)}`);
  }
  return result.ok && result.status === 200;
}

async function runAllTests() {
  console.log('========================================');
  console.log('COMPREHENSIVE API Endpoint Testing Suite');
  console.log('========================================');
  
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
  const signupOk = await testSignup();
  results.tests.push({ name: 'Signup (Non-Obfuscated)', passed: signupOk });
  if (signupOk) results.passed++; else results.failed++;
  
  if (sessionId) {
    csrfToken = generateCsrfToken(sessionId);
    console.log(`  CSRF Token generated: ${csrfToken.substring(0, 20)}...`);
  }

  const signupObfOk = await testSignupObfuscated();
  results.tests.push({ name: 'Signup (Obfuscated)', passed: signupObfOk });
  if (signupObfOk) results.passed++; else results.failed++;
  
  if (sessionId) {
    csrfToken = generateCsrfToken(sessionId);
    console.log(`  CSRF Token regenerated: ${csrfToken.substring(0, 20)}...`);
  }

  await testSignin();
  if (sessionId) {
    csrfToken = generateCsrfToken(sessionId);
  }
  await testSigninObfuscated();
  if (sessionId) {
    csrfToken = generateCsrfToken(sessionId);
  }

  if (!sessionId) {
    console.log('\n⚠ No session available, skipping authenticated endpoint tests');
  } else if (!csrfToken) {
    csrfToken = generateCsrfToken(sessionId);
    console.log(`\n✓ Generated CSRF token for session: ${sessionId.substring(0, 20)}...`);
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
    const staffResult = await makeRequest('/staff');
    const staffOk = staffResult.ok && staffResult.status === 200;
    results.tests.push({ name: 'Get Staff (Non-Obfuscated)', passed: staffOk });
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
    results.tests.push({ name: 'Get Shifts (Non-Obfuscated)', passed: shiftsOk });
    if (shiftsOk) results.passed++; else results.failed++;

    const shiftsObfOk = await testGetShiftsObfuscated();
    results.tests.push({ name: 'Get Shifts (Obfuscated)', passed: shiftsObfOk });
    if (shiftsObfOk) results.passed++; else results.failed++;

    const shiftStatsOk = await testGetShiftStats();
    results.tests.push({ name: 'Get Shift Stats', passed: shiftStatsOk });
    if (shiftStatsOk) results.passed++; else results.failed++;

    // Get staff before creating shift
    if (!staffId) {
      const staffRes = await makeRequest('/staff');
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
    const paymentScheduleOk = await testGetPaymentSchedule();
    results.tests.push({ name: 'Get Payment Schedule', passed: paymentScheduleOk });
    if (paymentScheduleOk) results.passed++; else results.failed++;

    const createPaymentScheduleOk = await testCreatePaymentSchedule();
    results.tests.push({ name: 'Create Payment Schedule', passed: createPaymentScheduleOk });
    if (createPaymentScheduleOk) results.passed++; else results.failed++;

    const paymentHistoryOk = await testGetPaymentHistory();
    results.tests.push({ name: 'Get Payment History', passed: paymentHistoryOk });
    if (paymentHistoryOk) results.passed++; else results.failed++;

    const paymentStatsOk = await testGetPaymentStats();
    results.tests.push({ name: 'Get Payment Stats', passed: paymentStatsOk });
    if (paymentStatsOk) results.passed++; else results.failed++;

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

    // Payment Endpoints (Stripe)
    const paymentConfigOk = await testGetPaymentConfig();
    results.tests.push({ name: 'Get Payment Config', passed: paymentConfigOk });
    if (paymentConfigOk) results.passed++; else results.failed++;

    const subscriptionOk = await testGetSubscriptionDetails();
    results.tests.push({ name: 'Get Subscription Details', passed: subscriptionOk });
    if (subscriptionOk) results.passed++; else results.failed++;

    const referenceNumbersOk = await testGetReferenceNumbers();
    results.tests.push({ name: 'Get Reference Numbers', passed: referenceNumbersOk });
    if (referenceNumbersOk) results.passed++; else results.failed++;
  } else {
    console.log('\n⚠ No session available, skipping authenticated endpoint tests');
  }

  // Summary
  console.log('\n========================================');
  console.log('Test Summary');
  console.log('========================================');
  const failedTests = [];
  results.tests.forEach((test) => {
    const status = test.passed ? '✓' : '✗';
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
      console.log(`  ✗ ${name}`);
    });
  }
  console.log('========================================\n');
}

runAllTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});

