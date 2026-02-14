#!/usr/bin/env node
/**
 * Test script for API security features
 * Tests API keys, session tokens, CSRF protection, and rate limiting
 */

import https from 'https';
import http from 'http';

const API_URL = process.env.API_URL || 'http://localhost:8080/api';

// Simple fetch implementation using Node.js http/https
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = client.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const headers = {};
        Object.keys(res.headers).forEach(key => {
          headers[key.toLowerCase()] = res.headers[key];
        });
        
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: {
            get: (name) => headers[name.toLowerCase()],
            entries: () => Object.entries(headers)
          },
          json: async () => {
            try {
              return JSON.parse(data);
            } catch (e) {
              return { error: 'Invalid JSON', raw: data };
            }
          },
          text: async () => data
        });
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(name) {
  log(`\nTesting: ${name}`, 'cyan');
  console.log('─'.repeat(60));
}

function logSuccess(message) {
  log(`${message}`, 'green');
}

function logError(message) {
  log(`${message}`, 'red');
}

function logWarning(message) {
  log(`${message}`, 'yellow');
}

function logInfo(message) {
  log(`${message}`, 'blue');
}

async function testRequest(method, endpoint, options = {}) {
  const url = `${API_URL}${endpoint}`;
  const config = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };

  if (options.body) {
    config.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, config);
    const data = await response.json().catch(() => ({ error: response.statusText }));
    return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
  } catch (error) {
    return { status: 0, error: error.message };
  }
}

async function main() {
  log('\nAPI Security Features Test Suite', 'cyan');
  log('='.repeat(60), 'cyan');

  // Test credentials (you'll need to provide these or create a test user)
  const testEmail = process.argv[2] || process.env.TEST_EMAIL || 'test@example.com';
  const testPassword = process.argv[3] || process.env.TEST_PASSWORD || 'testpassword123';

  logInfo(`Using test email: ${testEmail}`);
  logInfo(`API URL: ${API_URL}\n`);

  let sessionId = null;
  let csrfToken = null;
  let apiKey = null;

  // Test 1: Sign up or sign in
  logTest('1. Authentication (Sign In)');
  const signInResult = await testRequest('POST', '/auth/signin', {
    body: { email: testEmail, password: testPassword }
  });

  if (signInResult.status === 200 && signInResult.data.session) {
    sessionId = signInResult.data.session.id;
    logSuccess(`Signed in successfully. Session ID: ${sessionId.substring(0, 8)}...`);
  } else if (signInResult.status === 401) {
    logWarning('Sign in failed - user may not exist. Trying signup...');
    const signUpResult = await testRequest('POST', '/auth/signup', {
      body: { email: testEmail, password: testPassword, name: 'Test User' }
    });
    if (signUpResult.status === 200 || signUpResult.status === 201) {
      sessionId = signUpResult.data.session.id;
      logSuccess(`Signed up and signed in. Session ID: ${sessionId.substring(0, 8)}...`);
    } else {
      logError(`Signup failed: ${signUpResult.data?.error || signUpResult.error}`);
      process.exit(1);
    }
  } else {
    logError(`Sign in failed: ${signInResult.data?.error || signInResult.error}`);
    process.exit(1);
  }

  // Test 2: Get CSRF token
  logTest('2. CSRF Token Generation');
  const csrfResult = await testRequest('GET', '/auth/csrf-token', {
    headers: { 'Cookie': `sessionId=${sessionId}` }
  });

  if (csrfResult.status === 200 && csrfResult.data.csrfToken) {
    csrfToken = csrfResult.data.csrfToken;
    logSuccess(`CSRF token obtained: ${csrfToken.substring(0, 16)}...`);
  } else {
    logError(`Failed to get CSRF token: ${csrfResult.data?.error || csrfResult.error}`);
  }

  // Test 3: Create API Key
  logTest('3. API Key Creation');
  const apiKeyResult = await testRequest('POST', '/security/api-keys', {
    headers: { 'Authorization': `Bearer ${sessionId}` },
    body: {
      keyName: 'Test API Key',
      rateLimitPerMinute: 60,
      rateLimitPerHour: 1000
    }
  });

  if (apiKeyResult.status === 201 && apiKeyResult.data.apiKey) {
    apiKey = apiKeyResult.data.apiKey;
    logSuccess(`API key created: ${apiKey.substring(0, 11)}...`);
    logInfo(`IMPORTANT: Save this key - it won't be shown again!`);
  } else {
    logError(`Failed to create API key: ${apiKeyResult.data?.error || apiKeyResult.error}`);
    logInfo('Continuing with session token tests...');
  }

  // Test 4: Session token works on regular endpoint
  logTest('4. Session Token on Regular Endpoint (requireAuth)');
  const sessionTestResult = await testRequest('GET', '/staff', {
    headers: { 'Authorization': `Bearer ${sessionId}` }
  });

  if (sessionTestResult.status === 200) {
    logSuccess('Session token accepted on /api/staff');
  } else {
    logError(`Session token rejected: ${sessionTestResult.data?.error || sessionTestResult.error}`);
  }

  // Test 5: API key works on regular endpoint
  if (apiKey) {
    logTest('5. API Key on Regular Endpoint (requireAuth)');
    const apiKeyTestResult = await testRequest('GET', '/staff', {
      headers: { 'X-API-Key': apiKey }
    });

    if (apiKeyTestResult.status === 200) {
      logSuccess('API key accepted on /api/staff');
    } else {
      logError(`API key rejected: ${apiKeyTestResult.data?.error || apiKeyTestResult.error}`);
    }
  }

  // Test 6: Session token rejected on API-key-only endpoint (if we have one)
  logTest('6. Session Token on API-Key-Only Endpoint');
  logInfo('Note: This test requires an endpoint using requireApiKeyOnly');
  logInfo('If no such endpoint exists, this will test a regular endpoint');
  
  // Try to use session token where API key is required
  // Since we don't have an API-key-only endpoint yet, we'll test the concept
  if (apiKey) {
    // Test that API key works
    const apiKeyOnlyTest = await testRequest('GET', '/security/api-keys', {
      headers: { 'X-API-Key': apiKey }
    });

    if (apiKeyOnlyTest.status === 200) {
      logSuccess('API key works on security endpoint');
    } else {
      logWarning(`API key status: ${apiKeyOnlyTest.status} - ${apiKeyOnlyTest.data?.error || 'OK'}`);
    }
  }

  // Test 7: CSRF protection (if implemented on POST endpoints)
  logTest('7. CSRF Token Protection');
  if (csrfToken) {
    // Try POST without CSRF token (should fail if CSRF is required)
    const noCsrfResult = await testRequest('POST', '/staff', {
      headers: { 'Authorization': `Bearer ${sessionId}` },
      body: { name: 'Test Staff', role: 'Tester', hourlyRate: 25 }
    });

    if (noCsrfResult.status === 403 && noCsrfResult.data?.error?.includes('CSRF')) {
      logSuccess('CSRF protection is active (request without CSRF token rejected)');
      
      // Try with CSRF token (should succeed)
      const withCsrfResult = await testRequest('POST', '/staff', {
        headers: {
          'Authorization': `Bearer ${sessionId}`,
          'X-CSRF-Token': csrfToken
        },
        body: { name: 'Test Staff CSRF', role: 'Tester', hourlyRate: 25 }
      });

      if (withCsrfResult.status === 201 || withCsrfResult.status === 200) {
        logSuccess('CSRF token accepted (request with CSRF token succeeded)');
      } else {
        logWarning(`CSRF token may not be required yet: ${withCsrfResult.status}`);
      }
    } else {
      logWarning(`CSRF protection may not be enabled on this endpoint: ${noCsrfResult.status}`);
    }
  }

  // Test 8: Rate limiting headers
  logTest('8. Rate Limiting Headers');
  const rateLimitTest = await testRequest('GET', '/staff', {
    headers: { 'Authorization': `Bearer ${sessionId}` }
  });

  if (rateLimitTest.headers['x-ratelimit-limit']) {
    logSuccess(`Rate limit headers present:`);
    logInfo(`  Limit: ${rateLimitTest.headers['x-ratelimit-limit']}`);
    logInfo(`  Remaining: ${rateLimitTest.headers['x-ratelimit-remaining']}`);
    logInfo(`  Reset: ${new Date(parseInt(rateLimitTest.headers['x-ratelimit-reset']) * 1000).toLocaleString()}`);
  } else {
    logWarning('Rate limit headers not found (may not be enabled on this endpoint)');
  }

  // Test 9: Security audit logs
  logTest('9. Security Audit Logs');
  const auditLogsResult = await testRequest('GET', '/security/audit-logs?limit=5', {
    headers: { 'Authorization': `Bearer ${sessionId}` }
  });

  if (auditLogsResult.status === 200 && auditLogsResult.data.logs) {
    logSuccess(`Retrieved ${auditLogsResult.data.logs.length} audit log entries`);
    if (auditLogsResult.data.logs.length > 0) {
      logInfo(`Latest event: ${auditLogsResult.data.logs[0].event_type}`);
    }
  } else {
    logWarning(`Audit logs: ${auditLogsResult.status} - ${auditLogsResult.data?.error || 'OK'}`);
  }

  // Test 10: Session token misuse detection
  logTest('10. Session Token Misuse Detection');
  logInfo('Using session token in Authorization header (should be logged)');
  const misuseTest = await testRequest('GET', '/staff', {
    headers: { 'Authorization': `Bearer ${sessionId}` }
  });

  if (misuseTest.status === 200) {
    logSuccess('Request succeeded (misuse detection logs to database)');
    logInfo('Check /api/security/audit-logs for "session_token_in_authorization_header" events');
  }

  // Summary
  log('\n' + '='.repeat(60), 'cyan');
  log('Test Summary', 'cyan');
  log('='.repeat(60), 'cyan');
  
  if (sessionId) logSuccess('Session token authentication: Working');
  if (csrfToken) logSuccess('CSRF token generation: Working');
  if (apiKey) logSuccess('API key creation: Working');
  
  log('\nSecurity features test completed!', 'green');
  log('\nNext steps:', 'blue');
  log('  1. Check /api/security/audit-logs for security events', 'blue');
  log('  2. Test rate limiting by making rapid requests', 'blue');
  log('  3. Create API-key-only endpoints using requireApiKeyOnly', 'blue');
  log('  4. Enable CSRF protection on POST/PUT/DELETE endpoints', 'blue');
}

main().catch(error => {
  logError(`Test suite failed: ${error.message}`);
  console.error(error);
  process.exit(1);
});
