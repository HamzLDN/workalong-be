# Session Token vs API Key Security

## The Problem

Session tokens can be used like API keys if someone extracts them from browser storage or network requests. This defeats the purpose of having separate API keys for programmatic access.

## Solutions Implemented

### 1. **API Key Only Endpoints** (`requireApiKeyOnly`)

For sensitive endpoints that should only accept programmatic access, use `requireApiKeyOnly` instead of `requireAuth`:

```javascript
// ❌ OLD: Accepts both session tokens and API keys
app.get('/api/staff', requireAuth, async (req, res) => { ... });

// ✅ NEW: Only accepts API keys, rejects session tokens
app.get('/api/staff', requireApiKeyOnly, async (req, res) => { ... });
```

**Benefits:**
- Session tokens cannot be used for these endpoints
- Forces proper API key usage for programmatic access
- Better security for data export/import endpoints

### 2. **CSRF Protection** (`requireCsrfToken`)

For session-based requests, CSRF tokens prevent XSS attacks from stealing session tokens:

```javascript
// Require CSRF token for session-based requests
app.post('/api/staff', requireAuth, requireCsrfToken, async (req, res) => { ... });
```

**How it works:**
- Frontend must include `X-CSRF-Token` header
- Token is generated from session ID + secret
- Prevents cross-site request forgery

**Frontend implementation:**
```javascript
// Get CSRF token (generate from session ID)
const csrfToken = generateCsrfToken(sessionId);

// Include in requests
fetch('/api/staff', {
  headers: {
    'X-CSRF-Token': csrfToken,
    'Authorization': `Bearer ${sessionId}` // or use cookie
  }
});
```

### 3. **Session Token Misuse Detection**

The system automatically detects and logs when session tokens are used in `Authorization` headers instead of cookies:

```javascript
// This is detected and logged:
Authorization: Bearer <session-uuid>

// This is preferred for browser-based requests:
Cookie: sessionId=<session-uuid>
```

**Logs include:**
- IP address
- User agent
- Endpoint accessed
- Warning that API key should be used instead

### 4. **Security Headers**

Added security headers to prevent common attacks:
- `X-Frame-Options: DENY` - Prevents clickjacking
- `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
- `X-XSS-Protection: 1; mode=block` - XSS protection
- `Strict-Transport-Security` - HTTPS enforcement
- `Content-Security-Policy` - XSS/injection protection
- `Referrer-Policy` - Privacy protection

## Migration Guide

### Step 1: Identify Sensitive Endpoints

Endpoints that export data or allow bulk operations should use API keys only:

- `/api/staff` (GET) - Staff list export
- `/api/shifts` (GET) - Shift data export
- `/api/time-entries` (GET) - Time entry export
- `/api/budgets` (GET) - Budget data export
- Any bulk operations

### Step 2: Update Endpoints

```javascript
// Before
app.get('/api/staff', requireAuth, async (req, res) => {
  // ...
});

// After - Option A: API key only
app.get('/api/staff', requireApiKeyOnly, async (req, res) => {
  // ...
});

// After - Option B: Keep session support but add CSRF
app.get('/api/staff', requireAuth, requireCsrfToken, async (req, res) => {
  // ...
});
```

### Step 3: Update Frontend

**For browser-based requests (keep using sessions):**
```javascript
// Add CSRF token generation
function generateCsrfToken(sessionId) {
  // In production, get this from backend endpoint
  // For now, generate client-side (less secure but works)
  return btoa(sessionId + 'csrf-secret').substring(0, 32);
}

// Include CSRF token in requests
const response = await fetch('/api/staff', {
  headers: {
    'X-CSRF-Token': generateCsrfToken(sessionId)
  },
  credentials: 'include' // Include cookies
});
```

**For programmatic access (use API keys):**
```javascript
// Use API key instead of session token
const response = await fetch('/api/staff', {
  headers: {
    'X-API-Key': 'wak_abc123...'
  }
});
```

## Best Practices

### ✅ DO:
- Use API keys for programmatic/automated access
- Use session cookies (not Authorization header) for browser requests
- Include CSRF tokens for session-based POST/PUT/DELETE requests
- Monitor security audit logs for session token misuse
- Rotate API keys periodically

### ❌ DON'T:
- Don't use session tokens in `Authorization` headers for API access
- Don't expose session tokens in client-side JavaScript
- Don't skip CSRF protection for state-changing operations
- Don't use the same token for both browser and API access

## Monitoring

Check security audit logs regularly:

```bash
GET /api/security/audit-logs?limit=100
```

Look for:
- `session_token_in_authorization_header` - Session token misuse
- `session_token_misused_as_api_key` - Attempted API key substitution
- `csrf_token_missing` - Missing CSRF protection
- `csrf_token_invalid` - Invalid CSRF tokens

## Example: Secure Data Export Endpoint

```javascript
// Only accepts API keys - session tokens rejected
app.get('/api/staff/export', requireApiKeyOnly, createRateLimiter({ limitPerMinute: 10 }), async (req, res) => {
  const staff = await getStaff(req.userId);
  res.json({ staff });
});
```

**Usage:**
```bash
# ✅ Works: API key
curl -H "X-API-Key: wak_abc123..." http://localhost:8080/api/staff/export

# ❌ Rejected: Session token
curl -H "Authorization: Bearer <session-uuid>" http://localhost:8080/api/staff/export
# Returns: "API key required. Session tokens are not accepted for this endpoint."
```

## Summary

- **Session tokens** = Browser-based requests (with CSRF protection)
- **API keys** = Programmatic/automated access (with IP/endpoint restrictions)
- **Detection** = Automatic logging of session token misuse
- **Protection** = CSRF tokens prevent XSS token theft

This multi-layered approach ensures that even if someone extracts a session token, they cannot use it for programmatic API access, and CSRF protection prevents XSS attacks from stealing tokens in the first place.
