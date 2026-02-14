# API Security Features

This document describes the security features implemented to protect the Workalong API from reverse engineering and unauthorized access.

## Overview

The security system provides multiple layers of protection:

1. **API Key Authentication** - Programmatic access with fine-grained controls
2. **Rate Limiting** - Prevents abuse and brute force attacks
3. **IP Whitelisting** - Restrict access to specific IP addresses
4. **Request Signing** - HMAC-based request verification (optional)
5. **Request Fingerprinting** - Detect suspicious activity patterns
6. **Security Audit Logging** - Track all security events

## Setup

### 1. Run Database Migration

```bash
psql -U workalong -d users -f migrations/add-api-security.sql
```

This creates the following tables:
- `api_keys` - Stores API keys and their configurations
- `ip_whitelists` - IP address whitelists (global and per-user)
- `rate_limit_logs` - Rate limiting tracking
- `request_signing_keys` - HMAC signing keys
- `security_audit_logs` - Security event logs

### 2. Environment Configuration

No additional environment variables are required. The security features work with the existing database connection.

## Usage

### API Key Authentication

#### Creating an API Key

**Endpoint:** `POST /api/security/api-keys`

**Headers:**
```
Authorization: Bearer <session_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "keyName": "Production API Key",
  "expiresAt": "2026-12-31T23:59:59Z",  // Optional
  "allowedIps": ["192.168.1.100", "10.0.0.0/24"],  // Optional
  "allowedEndpoints": ["/api/staff/*", "/api/shifts"],  // Optional
  "rateLimitPerMinute": 60,  // Optional, default: 60
  "rateLimitPerHour": 1000   // Optional, default: 1000
}
```

**Response:**
```json
{
  "message": "API key created successfully",
  "apiKey": "wak_abc123...",  // ⚠️ SHOW THIS ONLY ONCE - Store securely!
  "key": {
    "id": "uuid",
    "keyName": "Production API Key",
    "prefix": "wak_abc12",
    "expiresAt": null,
    "allowedIps": ["192.168.1.100"],
    "allowedEndpoints": ["/api/staff/*"],
    "rateLimitPerMinute": 60,
    "rateLimitPerHour": 1000,
    "createdAt": "2026-02-01T00:00:00Z"
  }
}
```

**⚠️ Important:** The full API key (`apiKey` field) is only shown once when created. Store it securely - it cannot be retrieved again.

#### Using an API Key

Include the API key in one of two ways:

**Option 1: X-API-Key Header**
```
X-API-Key: wak_abc123def456...
```

**Option 2: Authorization Bearer**
```
Authorization: Bearer wak_abc123def456...
```

#### Listing API Keys

**Endpoint:** `GET /api/security/api-keys`

Returns all API keys for the authenticated user (without the full key, only prefix).

#### Revoking an API Key

**Endpoint:** `POST /api/security/api-keys/:keyId/revoke`

Sets `is_active = false` but keeps the key in the database for audit purposes.

#### Deleting an API Key

**Endpoint:** `DELETE /api/security/api-keys/:keyId`

Permanently removes the API key from the database.

### IP Whitelisting

#### Adding an IP Address

**Endpoint:** `POST /api/security/ip-whitelist`

**Request Body:**
```json
{
  "ipAddress": "192.168.1.100",
  "description": "Office IP"
}
```

Supports CIDR notation: `"192.168.1.0/24"`

#### Removing an IP Address

**Endpoint:** `DELETE /api/security/ip-whitelist/:ipAddress`

#### Listing Whitelisted IPs

**Endpoint:** `GET /api/security/ip-whitelist`

### Rate Limiting

Rate limiting is automatically applied to:
- All authenticated endpoints (via `requireAuth` middleware)
- Public endpoints like `/api/auth/signup` and `/api/auth/signin` (stricter limits)

**Rate Limit Headers:**
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1706745600
```

**Response when exceeded (429):**
```json
{
  "error": "Rate limit exceeded",
  "limit": 60,
  "resetAt": "2026-02-01T00:01:00Z"
}
```

### Request Signing (Advanced)

For additional security, you can require HMAC-based request signing:

1. Create a signing key via `createSigningKey()` function
2. Sign requests using HMAC-SHA256
3. Include headers: `X-Signature`, `X-Timestamp`, `X-Signing-Key-Id`

**Note:** Request signing is optional and requires additional implementation on the client side.

### Security Audit Logs

**Endpoint:** `GET /api/security/audit-logs?limit=100`

Returns security events including:
- API key creation/revocation
- Rate limit violations
- IP blocking events
- Suspicious activity detection

## Security Best Practices

1. **Store API Keys Securely**
   - Never commit API keys to version control
   - Use environment variables or secure key management
   - Rotate keys periodically

2. **Use IP Whitelisting**
   - Restrict API keys to specific IP addresses
   - Use CIDR notation for IP ranges

3. **Set Appropriate Rate Limits**
   - Default: 60 requests/minute, 1000/hour
   - Adjust based on your application's needs

4. **Monitor Audit Logs**
   - Regularly review security audit logs
   - Set up alerts for suspicious activity

5. **Endpoint Restrictions**
   - Limit API keys to only necessary endpoints
   - Use wildcard patterns: `/api/staff/*`

6. **Expiration Dates**
   - Set expiration dates for API keys
   - Rotate keys before expiration

## Integration Examples

### Using API Key with cURL

```bash
curl -H "X-API-Key: wak_abc123..." \
     https://api.workalong.co.uk/api/staff
```

### Using API Key with JavaScript

```javascript
const response = await fetch('https://api.workalong.co.uk/api/staff', {
  headers: {
    'X-API-Key': 'wak_abc123...',
    'Content-Type': 'application/json'
  }
});
```

### Using API Key with Python

```python
import requests

headers = {
    'X-API-Key': 'wak_abc123...',
    'Content-Type': 'application/json'
}

response = requests.get('https://api.workalong.co.uk/api/staff', headers=headers)
```

## Rate Limiting Details

- **Per-IP:** Applied to unauthenticated requests
- **Per-User:** Applied to session-based authenticated requests
- **Per-API-Key:** Applied to API key authenticated requests (uses key-specific limits)

Rate limits are tracked per endpoint and reset at the start of each time window (minute/hour).

## Troubleshooting

### "Invalid API key format"
- Ensure API key starts with `wak_`
- Check for typos or extra spaces

### "IP address not whitelisted"
- Verify the IP address matches exactly
- Check CIDR notation if using ranges
- Ensure the API key has IP restrictions configured

### "Rate limit exceeded"
- Check `X-RateLimit-Reset` header for reset time
- Reduce request frequency
- Consider increasing rate limits for the API key

### API Key Not Working
- Verify the key is active (`is_active = true`)
- Check expiration date (`expires_at`)
- Ensure IP address is whitelisted (if restrictions apply)
- Verify endpoint is allowed (if restrictions apply)

## Database Maintenance

### Cleanup Old Rate Limit Logs

```sql
SELECT cleanup_old_rate_limit_logs();
```

Runs automatically or can be scheduled via cron.

### Cleanup Old Audit Logs

```sql
SELECT cleanup_old_security_audit_logs();
```

Keeps critical logs for 1 year, others for 90 days.
