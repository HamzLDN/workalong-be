# WorkAlong Backend API Reference

<!--
  AGENT_METADATA (parse as constraints for tools that read this file)
  domain: workalong-backend
  api_prefix: /api
  swagger_ui: /api-docs
  source_of_truth: routes/index.js + routes/*.js + middleware/auth.js
-->

## Instructions for AI agents

Use this section as **system-level context** when planning API calls, debugging auth errors, or mapping user requests to endpoints.

### Your role

You are assisting with the **WorkAlong** employer/staff scheduling and payroll HTTP API. Every successful API plan must specify: **HTTP method**, **full path starting with `/api`**, **auth persona** (see below), and **required headers/body**.

### Personas (pick exactly one per request)

| Persona | Cookie | Bearer token | CSRF (`X-CSRF-Token`) | Notes |
|---------|--------|--------------|------------------------|--------|
| **Employer session** | `sessionId` | Same UUID as `Authorization: Bearer <uuid>` | Required for almost all `requireAuth` routes | Obtain CSRF via `GET /api/auth/csrf-token` after login. |
| **Employer API key** | — | `Authorization: Bearer wak_...` or `X-Api-Key: wak_...` | **Not used** | No CSRF. Subject to key scopes/rate limits. |
| **Staff session** | `staffSessionId` | Staff session UUID | **Not used** | Only `/api/staff/*` routes marked “Staff” in this doc. |
| **Public** | — | — | — | Only endpoints explicitly marked “None” or “Public”. |
| **Compat employer** | `sessionId` or `wak_` | Same as employer | **Skipped** | Only routes using `requireAuthCompat` (e.g. some `/api/clockin/*` employer actions). |

**Decision tree (answer in order):**

1. Is the user a **staff member** clocking in/out on the staff app? → Staff session → `/api/staff/auth/login` then staff routes.
2. Is the user the **company admin** in the main app? → Employer session + CSRF (or `wak_` key without CSRF).
3. Is this the **kiosk / shared tablet** clock-in page (device link, no employer login)? → Public clock-in routes under `/api/clockin/*` + device fingerprint headers.
4. Is this **Stripe webhooks**? → `POST /api/payment/webhook` with raw body (not JSON middleware path) — server-to-server only.

### Disambiguation (common mistakes)

- **`/api/payment`** = **Stripe** subscription checkout, billing portal, webhooks, publishable key.  
- **`/api/payments`** = **internal payroll** schedule, staff bank details, payment history, `process-*` — **not** Stripe charges in the same sense.
- **`/api/location`** = single company geofence on the user record. **`/api/locations`** = multi-site list (requires multi-location entitlement).
- **`GET /api/shifts`** allows API key **or** session; most other employer routes are session + CSRF.
- **403** often means missing/invalid **CSRF** (not “wrong password”). Try `GET /api/auth/csrf-token` first.

### Output conventions when you propose HTTP calls

When you write curl or fetch examples for this API, always include:

- `Content-Type: application/json` for JSON bodies.
- For employer session: `X-CSRF-Token` from `/api/auth/csrf-token` unless using `wak_`.
- For browser: `credentials: 'include'` if using cookies.

### Compact route index (search keys)

Use this to jump to the right section: `health`, `contact`, `demo-booking`, `auth`, `location`, `locations`, `staff`, `shifts`, `shift-swaps`, `time-entries`, `payroll-preview`, `earnings`, `budgets`, `clockin`, `payment` (Stripe), `payments` (payroll), `fraud`, `activities`, `security`, `support` (proxied).

---

All application routes are served under the **`/api`** prefix unless noted. Example: `GET https://your-host/api/health`.

Interactive OpenAPI documentation is available at **`/api-docs`** (Swagger UI) for a subset of routes that include Swagger annotations.

---

## Cross-cutting behavior

### JSON and cookies

- Send JSON with `Content-Type: application/json` (or `application/x-obfuscated` when using the obfuscation transport).
- Many flows use **cookies** (`sessionId` for employers, `staffSessionId` for staff). Use `credentials: 'include'` in browsers.
- **CORS** is configured for known origins; local dev often allows all origins.

### Employer authentication (`requireAuth`)

Valid session via:

- Cookie `sessionId`, **or**
- Header `Authorization: Bearer <session-uuid>` (same value as the session id).

**CSRF:** For mutating requests and most authenticated reads, send header:

- `X-CSRF-Token: <token>` where `<token>` comes from `GET /api/auth/csrf-token` (requires a valid session).

**API keys:** Header `X-Api-Key: wak_...` or `Authorization: Bearer wak_...`. API keys authenticate as the user **without** CSRF (see `middleware/auth.js`).

### Staff authentication (`requireStaffAuth`)

- Cookie `staffSessionId`, **or** `Authorization: Bearer <staff-session-uuid>`.

### Compatibility auth (`requireAuthCompat`)

Same as employer session/API key, but **CSRF is not required** (used for clock-in link management from contexts where CSRF is awkward).

### Rate limiting

- Global: `/api` is limited (defaults in `index.js`: 100/min, 5000/hour per client fingerprint).
- Some routes add stricter limits (e.g. API key creation).

### Response obfuscation

When the client activates the obfuscation protocol (see `middleware/obfuscation.js`), JSON responses may be wrapped and encoded. In **`NODE_ENV=dev`** with **`DISABLE_OBFUSCATION=true`**, plain JSON is used for easier debugging.

### Subscription-gated features (`requireSubscription`)

Used by fraud endpoints and some shift bulk actions. Requires an **active Stripe subscription** (verified live). In **`NODE_ENV=dev`**, subscription is bypassed (`trial` assumed). Otherwise returns **403** with `Premium subscription required` if not paid.

### Proxied routes (not implemented in this repo)

- **`/api/admin/*`** and **`/api/support/*`** — forwarded to the admin-panel API (`ADMIN_PANEL_API_URL`). Local **`NODE_ENV=dev`**: default upstream is `http://127.0.0.1:15055` (matches `admin_panel` dev server + Vite proxy). Production/Docker: default `http://127.0.0.1:5055` unless overridden.
- **`/socket.io`** — WebSocket proxy to the same upstream for support chat.

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | Liveness check. Returns `status`, `message`, and dev flags (`devPlainObfuscation`, `devSubscriptionBypass`). |

---

## Contact & marketing

| Method | Path | Auth | Body / notes |
|--------|------|------|----------------|
| `POST` | `/api/contact` | None | `{ name, email, subject, message }` — `company` optional. Sends contact email. |
| `POST` | `/api/demo-booking` | None | `{ name, email, date, timeSlot }` — `company`, `message` optional. Date must not be in the past. |

---

## Authentication — employers (`/api/auth`)

| Method | Path | Auth | How to use |
|--------|------|------|------------|
| `GET` | `/api/auth/public-csrf-token` | None | Returns `{ csrfToken }` and sets cookie `publicCsrfToken`. For **signup** only. |
| `POST` | `/api/auth/signup` | Public CSRF | Headers: `x-public-csrf-token` must match `publicCsrfToken` cookie. Body: `{ email, password, name, company? }`. Password ≥ 8 chars. Sets `sessionId` cookie. |
| `POST` | `/api/auth/signin` | None | Body: `{ email, password }`. May return `requires2FA`, `requiresTOTP`, `requiresEmailCode` instead of session. |
| `POST` | `/api/auth/verify-code` | None | After email code: `{ email, code, isTOTP? }`. Completes login; sets cookie. |
| `POST` | `/api/auth/verify-totp` | None | `{ email, code }` — TOTP-only completion. |
| `GET` | `/api/auth/2fa/status` | Session | Returns email/TOTP 2FA flags. |
| `POST` | `/api/auth/2fa/email/enable` | Session + CSRF | Enables email 2FA. |
| `POST` | `/api/auth/2fa/email/disable` | Session + CSRF | Disables email 2FA. |
| `POST` | `/api/auth/2fa/totp/generate` | Session + CSRF | Returns `secret`, `qrCode`, `otpauthUrl`, `reused`. |
| `POST` | `/api/auth/2fa/totp/enable` | Session + CSRF | Body: `{ code }` — 6-digit TOTP to confirm. |
| `POST` | `/api/auth/2fa/totp/disable` | Session + CSRF | Disables TOTP (keeps secret for re-enable). |
| `POST` | `/api/auth/2fa/totp/reset` | Session + CSRF | Clears TOTP secret and disables. |
| `GET` | `/api/auth/session-id` | Cookie session | Returns `{ sessionId }` if cookie valid (for clients syncing storage). |
| `GET` | `/api/auth/csrf-token` | Session (cookie or Bearer) | Returns `{ csrfToken }` for `X-CSRF-Token` on subsequent calls. |
| `GET` | `/api/auth/me` | Session + **CSRF header** | Returns current user. **Requires** `X-CSRF-Token`. |
| `POST` | `/api/auth/forgot-password` | None | `{ email }` — always 200-style message (no enumeration). |
| `POST` | `/api/auth/reset-password` | None | `{ token, password }`. |
| `POST` | `/api/auth/signout` | Session | Clears `sessionId`. |
| `PUT` | `/api/auth/profile` | Session + CSRF | Updates `{ name?, email?, latitude?, longitude?, timezone? }`. Email change resets verification. |

---

## Company location (single geofence) — `/api/location`

Default workplace circle stored on the **user** row (used when multi-location is off).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/location` | Session + CSRF | `{ latitude, longitude, radius }`. |
| `PUT` | `/api/location` | Session + CSRF | Body: `{ latitude?, longitude?, radius? }` (radius 10–10000 m). |

---

## Multi-location — `/api/locations`

Requires **multi-location** on the account (DB flag or Stripe metadata). Otherwise **403**.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/locations` | Session + CSRF | List named geofences. |
| `POST` | `/api/locations` | Session + CSRF | `{ name, latitude, longitude, radius? }`. |
| `PUT` | `/api/locations/:id` | Session + CSRF | Partial update of fields. |
| `DELETE` | `/api/locations/:id` | Session + CSRF | Delete location. |

---

## Staff (employer CRUD & staff portal) — `/api/staff`

**Employer** routes use session + CSRF. **Staff** routes use `staffSessionId` / Bearer staff token.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/staff/auth/login` | None | `{ username, password }` — sets `staffSessionId`. |
| `GET` | `/api/staff/auth/me` | Staff | Current staff + `companyLocation` lat/lng. |
| `POST` | `/api/staff/auth/logout` | Staff | Clears staff session. |
| `GET` | `/api/staff/validate-token` | None | Query `token` — password-setup token validity. |
| `POST` | `/api/staff/set-password` | None | `{ token, password }` — first-time password from invite. |
| `POST` | `/api/staff/:id/reset-password` | Employer | Triggers reset email for that staff member. |
| `GET` | `/api/staff` | Employer | Lists all staff. |
| `GET` | `/api/staff/stats` | Employer | Query `clientDate?` — dashboard stats. |
| `POST` | `/api/staff/clock-in` | Staff | Body: `{ latitude?, longitude? }` — geofence checked when coords provided. |
| `POST` | `/api/staff/clock-out` | Staff | `{ latitude?, longitude?, lateReason? }` — late reason if >10 min after scheduled end. |
| `GET` | `/api/staff/my-shifts` | Staff | Query `startDate`, `endDate`. |
| `GET` | `/api/staff/my-time-entries` | Staff | Query `startDate`, `endDate`. |
| `GET` | `/api/staff/clock-status` | Staff | Whether currently clocked in today. |
| `GET` | `/api/staff/:id` | Employer | Single staff record. |
| `POST` | `/api/staff` | Employer | `{ name, role, hourlyRate, email?, employmentType? }` — subject to plan staff limits. |
| `PUT` | `/api/staff/:id` | Employer | Update fields including `status`. |
| `DELETE` | `/api/staff/:id` | Employer | Delete staff. |

---

## Shifts & shift swaps — `/api/...`

Mounted at **`/api`** (no extra prefix).

### Shifts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/shifts` | Session + CSRF **or** `wak_` API key | Query: `startDate`, `endDate`, `staffId`, `status`, `timezoneOffset`, `clientNow`. Returns `{ shifts }`. |
| `GET` | `/api/shifts/stats` | Session + CSRF | Query `startDate`, `endDate`. |
| `GET` | `/api/shifts/:id` | Session + CSRF | Single shift. |
| `POST` | `/api/shifts` | Session + CSRF | `{ staffId, shiftDate, startTime, hours, breakMinutes?, shiftType?, payType?, location?, notes? }`. |
| `POST` | `/api/shifts/bulk` | Session + CSRF + **subscription** | `{ shifts: [...] }` — array of shift objects. |
| `PUT` | `/api/shifts/:id` | Session + CSRF | Update fields; may include `clockedInTime`, `clockedOutTime`. |
| `DELETE` | `/api/shifts/:id` | Session + CSRF | Delete shift. |
| `POST` | `/api/shifts/:id/approve` | Session + CSRF | Approve shift → creates/updates time entry. |
| `POST` | `/api/shifts/approve-bulk` | Session + CSRF + **subscription** | `{ shiftIds: number[] }`. |
| `POST` | `/api/shifts/:id/unapprove` | Session + CSRF | Reverse approval. |
| `POST` | `/api/shifts/:id/swap-request` | Staff | `{ requestedShiftId, message? }` — request swapping `:id` for another shift. |

### Shift swaps

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/shift-swaps` | Staff **or** employer (session + CSRF) | Query `status?`. List swaps for staff or whole company. |
| `GET` | `/api/shift-swaps/:id` | Staff or employer | Single request. |
| `POST` | `/api/shift-swaps/:id/accept` | Staff | Accept swap. |
| `POST` | `/api/shift-swaps/:id/reject` | Staff | Reject. |
| `DELETE` | `/api/shift-swaps/:id` | Staff | Cancel own pending request. |

---

## Time entries & payroll preview — `/api/...`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/time-entries` | Employer | Query `staffId`, `startDate`, `endDate`. |
| `GET` | `/api/time-entries/pending` | Employer | Pending approval (`clock_in_out` entries). Same query filters. |
| `POST` | `/api/time-entries/:id/approve` | Employer | Approve entry. |
| `POST` | `/api/time-entries/:id/unapprove` | Employer | Unapprove. |
| `GET` | `/api/payroll-preview` | Employer | Query **`startDate`**, **`endDate`** (required) — payroll from clocked hours. |
| `GET` | `/api/earnings/monthly` | Employer | Query `year`, `month` — chart data. |
| `POST` | `/api/time-entries` | Employer | Manual entry: `{ staffId, date, hoursWorked, overtimeHours?, notes?, leaveCategory? }`. |
| `PUT` | `/api/time-entries/:id` | Employer | Same fields as create (full replace of required fields). |
| `DELETE` | `/api/time-entries/:id` | Employer | Delete entry (rules in service layer). |

---

## Budgets — `/api/budgets`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/budgets` | Employer | List budgets. |
| `GET` | `/api/budgets/active` | Employer | Active budget. |
| `POST` | `/api/budgets` | Employer | `{ name, monthlyBudget, startDate, endDate? }`. |
| `PUT` | `/api/budgets/:id` | Employer | Update including `status`. |
| `GET` | `/api/budgets/stats` | Employer | Aggregate stats. |

---

## Clock-in kiosk / device links — `/api/clockin`

Device links open on the frontend at `/clockin/:token`. Most calls need **`X-Device-Fingerprint`** (or body `deviceFingerprint` / query `fingerprint` where noted).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/clockin/generate-link` | `requireAuthCompat` | `{ deviceName?, expiresInDays? }` — returns URL with token. |
| `GET` | `/api/clockin/links` | `requireAuthCompat` | Lists device links for employer. |
| `DELETE` | `/api/clockin/links/:linkId` | `requireAuthCompat` | Revoke link. |
| `GET` | `/api/clockin/verify-link/:token` | None | Header or query **fingerprint** required. Validates token, binds fingerprint on first use. |
| `POST` | `/api/clockin/face/enroll` | None | `{ clockinId, linkToken, faceHash / faceHashes / faceEmbeddings, ... }` + fingerprint. |
| `POST` | `/api/clockin/face/verify` | None | Verify face for known `clockinId`. |
| `POST` | `/api/clockin/face/identify` | None | Identify staff from face among enrolled profiles for the link’s company. |
| `POST` | `/api/clockin/clock-action` | None | `{ clockinId, action: 'clock-in' \| 'clock-out', linkToken, latitude?, longitude?, faceHash?, faceEmbedding?, lateReason? }` + fingerprint. |
| `GET` | `/api/clockin/status/:linkToken` | None | Query `clockinId`; fingerprint header/query. Returns open clock-in state for today. |

---

## Stripe subscription — `/api/payment`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/payment/create-checkout-session` | Employer | `{ totalPrice, billingCycle: 'monthly'\|'yearly', staffCount?, multiLocation?, promoCode? }` → Stripe Checkout `url`. |
| `POST` | `/api/payment/update-subscription` | Employer | Change plan/pricing; may return `requiresAction` + invoice URL. |
| `POST` | `/api/payment/verify-session` | Employer | `{ sessionId }` — after Checkout; syncs subscription. |
| `POST` | `/api/payment/webhook` | Stripe | **Raw body**; header `Stripe-Signature`. Not for app clients. |
| `POST` | `/api/payment/billing-portal` | Employer | Returns Stripe billing portal `url`. |
| `POST` | `/api/payment/cancel-subscription` | Employer | Cancel at period end or refund window per logic. |
| `GET` | `/api/payment/subscription-details` | Employer | Stripe subscription snapshot. |
| `GET` | `/api/payment/verify-subscription` | Employer | Status check. |
| `POST` | `/api/payment/sync-subscription` | Employer | Force re-verify from Stripe. |
| `GET` | `/api/payment/reference-numbers` | Employer | Payment references for accounting. |
| `GET` | `/api/payment/config` | **Public** | `{ publishableKey }` for Stripe.js. |

---

## Payroll runs & staff bank details — `/api/payments`

Internal “process payment” flows record **`payment_history`** and simulate completion after a delay (see code comments for production integration).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/payments/schedule` | Employer | Current `payment_schedules` row or null. |
| `POST` | `/api/payments/schedule` | Employer | `{ scheduleType: 'weekly'\|'bi-weekly'\|'monthly'\|'custom', paymentDay, customSchedule? }`. |
| `DELETE` | `/api/payments/schedule` | Employer | Sets schedule inactive. |
| `GET` | `/api/payments/staff/:staffId/details` | Employer | Bank metadata (account/IBAN not returned to client). |
| `POST` | `/api/payments/staff/:staffId/details` | Employer | `{ paymentMethod, accountHolderName, bankName, accountNumber?, sortCode?, iban?, swiftBic? }`. |
| `POST` | `/api/payments/process/:staffId` | Employer | `{ periodStart?, periodEnd?, amount?, notes? }` — amount computed from approved clocked time if period given. |
| `POST` | `/api/payments/process-all` | Employer | `{ periodStart, periodEnd }` — batch process eligible staff. |
| `GET` | `/api/payments/history` | Employer | Query `status`, `staffId`, `limit`, `offset`. |
| `GET` | `/api/payments/stats` | Employer | Last 30 days aggregates. |

---

## Fraud detection — `/api/fraud`

All routes: **session + CSRF + active subscription** (dev bypasses subscription).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/fraud/analyze/:staffId` | Body `{ days? }` (default 30) — analyze one staff, create flags. |
| `POST` | `/api/fraud/analyze-all` | All staff. |
| `GET` | `/api/fraud/flags` | Query `staffId`, `includeResolved`. |
| `GET` | `/api/fraud/stats` | Summary stats. |
| `PUT` | `/api/fraud/flags/:id/resolve` | Body `{ notes? }`. |

---

## Activity log — `/api/activities`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/activities` | Employer | Query `limit`, `offset`. |
| `GET` | `/api/activities/stats` | Employer | Aggregated activity stats. |

---

## Security (API keys & IP allowlist) — `/api/security`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/security/api-keys` | Employer + CSRF | Create key: `{ keyName, expiresAt?, allowedIps?, allowedEndpoints?, rateLimitPerMinute?, rateLimitPerHour? }`. Returns **full key once** (`wak_...`). |
| `GET` | `/api/security/api-keys` | Employer | List keys (metadata only). |
| `POST` | `/api/security/api-keys/:keyId/revoke` | Employer | Revoke. |
| `DELETE` | `/api/security/api-keys/:keyId` | Employer | Delete. |
| `POST` | `/api/security/ip-whitelist` | Employer | `{ ipAddress, description? }`. |
| `DELETE` | `/api/security/ip-whitelist/:ipAddress` | Employer | URL-encoded IP. |
| `GET` | `/api/security/ip-whitelist` | Employer | List. |
| `GET` | `/api/security/audit-logs` | Employer **admin** | Query `limit`. Requires `users.is_admin = true`. |

---

## Typical call sequences

### Employer web app

1. `POST /api/auth/signin` (or signup with public CSRF flow).
2. `GET /api/auth/csrf-token` → store `X-CSRF-Token` for mutations.
3. Call protected routes with cookie **or** `Authorization: Bearer <sessionId>` + `X-CSRF-Token`.

### Staff mobile / web

1. `POST /api/staff/auth/login`.
2. Use `GET /api/staff/clock-status`, `POST /api/staff/clock-in`, etc., with staff cookie or Bearer.

### Server-to-server with API key

1. Create key via `POST /api/security/api-keys` (once, from authenticated browser session).
2. Use `Authorization: Bearer wak_...` on allowed endpoints; **no CSRF**.

---

## Status codes (common)

- **400** — validation / bad input  
- **401** — missing or invalid session/API key  
- **403** — CSRF failure, geofence, subscription, or permission  
- **404** — resource not found  
- **409** — conflict (e.g. overlapping shift)  
- **410** — expired link (clock-in device link)  
- **500** — server error  

### Paste-ready primer (for `AGENTS.md`, Cursor rules, or chat system prompts)

```text
WorkAlong API: All routes under /api. Swagger at /api-docs.
Employer: cookie sessionId OR Bearer session UUID; add X-CSRF-Token from GET /api/auth/csrf-token for requireAuth routes.
API key: Bearer wak_... or X-Api-Key — no CSRF.
Staff: staffSessionId or Bearer staff session — routes under /api/staff/* for portal.
Do not confuse /api/payment (Stripe) with /api/payments (payroll/bank/history).
Full tables: workalong-backend/docs/API.md
```

This document is generated from route registration in `routes/index.js` and handlers under `routes/`. If behavior diverges, the source files are authoritative.
