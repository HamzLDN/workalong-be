# Endpoint Security Guide

## Security Levels

### Level 1: Public (No Auth)
- Health checks
- Public information endpoints
- Rate limited: 10/min, 100/hour

### Level 2: Session-Based (Browser)
- User dashboard endpoints
- UI interaction endpoints
- Uses: `requireAuth` + `requireCsrfToken` (for POST/PUT/DELETE)
- Rate limited: 60/min, 1000/hour

### Level 3: API Key Only (Programmatic)
- Data export endpoints
- Bulk operations
- Integration endpoints
- Uses: `requireApiKeyOnly`
- Rate limited: Per API key configuration

### Level 4: Hybrid (Both Accepted)
- General data endpoints
- Uses: `requireAuth` (accepts both session and API key)
- Rate limited: 60/min, 1000/hour

## Current Endpoint Security

### ✅ Already Protected (Session + CSRF)
- `POST /api/staff` - Create staff
- `PUT /api/staff/:id` - Update staff
- `DELETE /api/staff/:id` - Delete staff
- `POST /api/shifts` - Create shift
- `PUT /api/shifts/:id` - Update shift
- `DELETE /api/shifts/:id` - Delete shift
- `POST /api/time-entries` - Create time entry
- `POST /api/budgets` - Create budget
- `PUT /api/budgets/:id` - Update budget

### 🔄 Hybrid (Session or API Key)
- `GET /api/staff` - List staff (currently `requireAuth`)
- `GET /api/shifts` - List shifts (currently hybrid)
- `GET /api/time-entries` - List time entries (currently `requireAuth`)
- `GET /api/budgets` - List budgets (currently `requireAuth`)

### 🔒 Recommended: API Key Only
These endpoints should use `requireApiKeyOnly` for better security:

```javascript
// Data export endpoints (sensitive)
app.get('/api/staff/export', requireApiKeyOnly, ...);
app.get('/api/shifts/export', requireApiKeyOnly, ...);
app.get('/api/time-entries/export', requireApiKeyOnly, ...);
app.get('/api/budgets/export', requireApiKeyOnly, ...);

// Bulk operations
app.post('/api/shifts/bulk', requireApiKeyOnly, ...);
app.post('/api/staff/bulk', requireApiKeyOnly, ...);
```

## Migration Checklist

- [ ] Identify sensitive data export endpoints
- [ ] Change from `requireAuth` to `requireApiKeyOnly` for exports
- [ ] Add `requireCsrfToken` to all POST/PUT/DELETE endpoints using sessions
- [ ] Update frontend to:
  - [ ] Get CSRF token from `/api/auth/csrf-token`
  - [ ] Include CSRF token in all state-changing requests
  - [ ] Use API keys for programmatic access
- [ ] Test both session and API key authentication
- [ ] Monitor security audit logs for misuse

## Frontend Integration

### Getting CSRF Token

```javascript
// After login, get CSRF token
const response = await fetch('/api/auth/csrf-token', {
  credentials: 'include' // Include session cookie
});
const { csrfToken } = await response.json();

// Store for use in requests
localStorage.setItem('csrfToken', csrfToken);
```

### Using CSRF Token

```javascript
// Include in all POST/PUT/DELETE requests
fetch('/api/staff', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': localStorage.getItem('csrfToken')
  },
  credentials: 'include',
  body: JSON.stringify({ ... })
});
```

### Using API Keys

```javascript
// For programmatic access
fetch('/api/staff/export', {
  headers: {
    'X-API-Key': 'wak_abc123...'
  }
});
```

## Testing

### Test Session-Based Access
```bash
# 1. Login to get session cookie
curl -c cookies.txt -X POST http://localhost:8080/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}'

# 2. Get CSRF token
curl -b cookies.txt http://localhost:8080/api/auth/csrf-token

# 3. Use CSRF token in request
curl -b cookies.txt -X POST http://localhost:8080/api/staff \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <csrf-token>" \
  -d '{"name":"John","role":"Manager","hourlyRate":25}'
```

### Test API Key Access
```bash
# Use API key directly
curl -H "X-API-Key: wak_abc123..." \
     http://localhost:8080/api/staff/export
```

### Test API Key Only Protection
```bash
# Try session token (should fail)
curl -H "Authorization: Bearer <session-uuid>" \
     http://localhost:8080/api/staff/export
# Expected: "API key required. Session tokens are not accepted..."
```

## Monitoring

Check security audit logs regularly:

```bash
GET /api/security/audit-logs?limit=100
```

Look for:
- `session_token_misused_as_api_key` - Someone trying to use session as API key
- `csrf_token_missing` - Missing CSRF protection
- `csrf_token_invalid` - Invalid CSRF tokens
- `api_key_invalid` - Invalid API key attempts
