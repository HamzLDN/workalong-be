# API Restriction Guide

## How CSRF Protection Restricts Access

### Current Protection (CSRF on All Session Requests)

**What it does:**
- ✅ Prevents session tokens from being used programmatically without CSRF token
- ✅ Requires same-origin requests to get CSRF tokens
- ✅ Makes it much harder to scrape/automate API access from the website
- ✅ Protects against XSS attacks stealing session tokens

**Limitation:**
- Session tokens can still be used if attacker gets CSRF token (requires same-origin access)
- Frontend can still access all endpoints (by design - it's your website)

### Maximum Restriction: API Key Only Endpoints

For endpoints you want to **completely restrict** from website access, use `requireApiKeyOnly`:

```javascript
// ❌ Current: Website can access with session token + CSRF
app.get('/api/staff', requireAuth, async (req, res) => { ... });

// ✅ Maximum restriction: Only API keys work, website blocked
app.get('/api/staff', requireApiKeyOnly, async (req, res) => { ... });
```

**What this does:**
- ✅ **Completely blocks** session tokens (even with CSRF)
- ✅ **Only accepts** API keys (`wak_...`)
- ✅ Forces users to create API keys for programmatic access
- ✅ You control who gets API keys and can revoke them

## Restriction Levels

### Level 1: Public (No Restriction)
```javascript
app.get('/api/health', async (req, res) => { ... });
```
- Anyone can access
- Use for: Health checks, public info

### Level 2: Session + CSRF (Current Default)
```javascript
app.get('/api/staff', requireAuth, async (req, res) => { ... });
```
- Website users can access (with CSRF token)
- API keys also work
- **Restriction level: Medium** - Hard to automate, but website can still access

### Level 3: API Key Only (Maximum Restriction)
```javascript
app.get('/api/staff/export', requireApiKeyOnly, async (req, res) => { ... });
```
- **Website CANNOT access** (even with session token)
- **Only API keys work**
- **Restriction level: High** - Complete control over who accesses

## Recommended Restrictions

### Keep Session Access (Level 2) For:
- ✅ Dashboard data (`GET /api/staff`, `GET /api/shifts`)
- ✅ UI interactions (create/edit/delete operations)
- ✅ User settings

### Use API Key Only (Level 3) For:
- 🔒 **Data exports** (`/api/staff/export`, `/api/shifts/export`)
- 🔒 **Bulk operations** (`/api/shifts/bulk`, `/api/staff/bulk`)
- 🔒 **Webhooks/Integrations** (if you add them)
- 🔒 **Sensitive reports** (financial data, audit logs)

## Implementation Examples

### Example 1: Restrict Data Export Endpoints

```javascript
// Before: Website can export data
app.get('/api/staff/export', requireAuth, async (req, res) => { ... });

// After: Only API keys can export
app.get('/api/staff/export', requireApiKeyOnly, async (req, res) => { ... });
```

### Example 2: Restrict Bulk Operations

```javascript
// Before: Website can bulk create
app.post('/api/shifts/bulk', requireAuth, async (req, res) => { ... });

// After: Only API keys can bulk create
app.post('/api/shifts/bulk', requireApiKeyOnly, async (req, res) => { ... });
```

### Example 3: Hybrid Approach (Keep Some Access)

```javascript
// Website can view shifts
app.get('/api/shifts', requireAuth, async (req, res) => { ... });

// But only API keys can export
app.get('/api/shifts/export', requireApiKeyOnly, async (req, res) => { ... });
```

## Testing Restrictions

### Test Session Token Rejection

```bash
# This should FAIL with API key only endpoint
curl -H "Authorization: Bearer <session-uuid>" \
     -H "X-CSRF-Token: <csrf-token>" \
     http://localhost:8081/api/staff/export

# Expected: "API key required. Session tokens are not accepted..."
```

### Test API Key Acceptance

```bash
# This should WORK
curl -H "X-API-Key: wak_abc123..." \
     http://localhost:8081/api/staff/export

# Expected: Data export
```

## Additional Restrictions Available

### 1. IP Whitelisting
```javascript
// Only allow API keys from specific IPs
const apiKey = await createApiKey(userId, {
  keyName: 'Production Server',
  allowedIps: ['203.0.113.0/24'] // Only this IP range
});
```

### 2. Endpoint Restrictions
```javascript
// Only allow API key to access specific endpoints
const apiKey = await createApiKey(userId, {
  keyName: 'Export Only',
  allowedEndpoints: ['/api/staff/export', '/api/shifts/export']
});
```

### 3. Rate Limiting
```javascript
// Limit API key to specific rate
const apiKey = await createApiKey(userId, {
  keyName: 'Limited Access',
  rateLimitPerMinute: 10,  // Only 10 requests per minute
  rateLimitPerHour: 100    // Only 100 requests per hour
});
```

## Migration Strategy

1. **Identify sensitive endpoints** you want to restrict
2. **Change from `requireAuth` to `requireApiKeyOnly`**
3. **Update documentation** to tell users they need API keys
4. **Monitor audit logs** for blocked attempts
5. **Gradually restrict** more endpoints as needed

## Current Status

### Already Restricted (API Key Only):
- None yet (you can add these)

### Currently Session Accessible (with CSRF):
- `GET /api/staff` - List staff
- `GET /api/shifts` - List shifts  
- `GET /api/time-entries` - List time entries
- All POST/PUT/DELETE operations

### Recommended to Restrict:
- Data export endpoints (if you add them)
- Bulk operation endpoints
- Webhook endpoints (if you add them)

## Summary

**CSRF protection already restricts access significantly:**
- ✅ Hard to automate/scrape from website
- ✅ Requires same-origin requests
- ✅ Protects against XSS token theft

**For maximum restriction, use `requireApiKeyOnly`:**
- ✅ Complete control over access
- ✅ Can revoke API keys anytime
- ✅ Can restrict by IP, endpoint, rate limit
- ✅ Website cannot access these endpoints

**Recommendation:**
- Keep CSRF on all endpoints (already done ✅)
- Use `requireApiKeyOnly` for sensitive operations (exports, bulk ops)
- Monitor audit logs for misuse attempts
