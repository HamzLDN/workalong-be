# Security Features Quick Start

## 🚀 Quick Setup (3 Steps)

### 1. Run Database Migration

```bash
cd workalong-backend
./scripts/setup-security.sh
```

Or manually:
```bash
psql -U workalong -d users -f migrations/add-api-security.sql
```

### 2. Restart Backend Server

```bash
npm run dev
# or
npm start
```

### 3. Create Your First API Key

**Via API:**
```bash
curl -X POST http://localhost:8080/api/security/api-keys \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keyName": "My API Key",
    "rateLimitPerMinute": 60,
    "rateLimitPerHour": 1000
  }'
```

**Response:**
```json
{
  "message": "API key created successfully",
  "apiKey": "wak_abc123def456...",  // ⚠️ SAVE THIS - shown only once!
  "key": { ... }
}
```

## 🔑 Using API Keys

### Option 1: X-API-Key Header
```bash
curl -H "X-API-Key: wak_abc123..." \
     http://localhost:8080/api/staff
```

### Option 2: Authorization Bearer
```bash
curl -H "Authorization: Bearer wak_abc123..." \
     http://localhost:8080/api/staff
```

## 🛡️ Security Features Enabled

✅ **API Key Authentication** - Secure programmatic access  
✅ **Rate Limiting** - Prevents abuse (60/min, 1000/hour default)  
✅ **IP Whitelisting** - Restrict access to specific IPs  
✅ **Request Fingerprinting** - Detect suspicious activity  
✅ **Security Audit Logs** - Track all security events  
✅ **Endpoint Restrictions** - Limit API keys to specific endpoints  

## 📊 Rate Limits

- **Public endpoints** (signup/signin): 5/min, 20/hour
- **Authenticated endpoints**: 60/min, 1000/hour (default)
- **Customizable per API key**

## 🔍 Monitoring

View security audit logs:
```bash
curl -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
     http://localhost:8080/api/security/audit-logs
```

## 📖 Full Documentation

See `README-SECURITY.md` for complete documentation.
