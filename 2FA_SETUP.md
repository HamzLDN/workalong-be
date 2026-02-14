# Two-Factor Authentication Setup

## Overview

The system supports **two types of 2FA**:
1. **Email-based 2FA** - Sends 6-digit codes via email (default, always enabled)
2. **Google Authenticator (TOTP)** - Uses authenticator apps like Google Authenticator, Authy, Microsoft Authenticator

**Priority:** When Google Authenticator is enabled, it takes priority over email 2FA. Email 2FA is automatically disabled when TOTP is enabled, and re-enabled when TOTP is disabled.

## Installation

Install the required packages for TOTP support:

```bash
cd workalong-backend
npm install speakeasy qrcode
```

## Database Migration

Run the migration to add 2FA fields to the users table:

```bash
psql -U workalong -d workalong -f migrations/add-2fa.sql
```

This adds:
- `email_2fa_enabled` - Controls email-based 2FA (defaults to TRUE)
- `totp_secret` - Stores TOTP secret for Google Authenticator
- `totp_enabled` - Controls TOTP 2FA (defaults to FALSE)

## Implementation Status

✅ **Complete Features:**
- Database schema for both email and TOTP 2FA
- Backend endpoints for both methods
- Frontend component for managing both 2FA types
- Login flow supports both email codes and TOTP codes
- TOTP secret generation with QR codes
- Proper TOTP verification using speakeasy

## API Endpoints

### Get 2FA Status
- `GET /api/auth/2fa/status` - Returns `{ emailEnabled, totpEnabled, enabled }`

### Email 2FA
- `POST /api/auth/2fa/email/enable` - Enable email 2FA
- `POST /api/auth/2fa/email/disable` - Disable email 2FA

### TOTP (Google Authenticator)
- `POST /api/auth/2fa/totp/generate` - Generate secret and QR code
- `POST /api/auth/2fa/totp/enable` - Enable TOTP (requires verification code)
- `POST /api/auth/2fa/totp/disable` - Disable TOTP

## How It Works

1. **Email 2FA (Default):**
   - User signs in → receives email code → enters code → logged in
   - Can be enabled/disabled from Settings

2. **Google Authenticator:**
   - User sets up in Settings → scans QR code → verifies with code → TOTP enabled
   - When enabled, email 2FA is automatically disabled
   - User signs in → enters TOTP code from app → logged in

3. **Both Disabled:**
   - User signs in → logged in directly (no code required)
