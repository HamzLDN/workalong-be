# Obfuscation Transport Protocol

Source of truth: `middleware/obfuscation.js`

---

## Overview

Non-public API endpoints require every request to use a **signed transport protocol**. This serves two purposes:

1. **Request integrity** — each request carries a HMAC-style signature so the server can reject replayed, tampered, or out-of-order calls.
2. **Body obfuscation** — the JSON request body is XOR-encoded before sending, and the JSON response body is XOR-encoded before returning. Neither side sends readable plaintext for authenticated calls.

The protocol is intentionally lightweight (no TLS-level overhead beyond HTTPS) and is applied at the Express middleware layer before any route handler runs.

---

## Dev / CI bypass

When `NODE_ENV=dev` **and** `DISABLE_OBFUSCATION=true`, the middleware skips signature verification and XOR coding so you can use plain JSON with curl or Postman. The `npm run dev` script sets both automatically.

- Requests that still opt in to the signed transport (send the activation header) are validated even in dev mode, so security tests work against the local server.
- If a request body arrives in the `{ format: "information", data: "..." }` wrapper in dev mode, the middleware **will still deobfuscate it** so route handlers receive normal JSON. This allows the same test client to work in both modes.

Trusted internal services (e.g. `workalong-ai`) can bypass obfuscation entirely by sending `X-Workalong-Internal-Secret: <INTERNAL_SERVICE_SECRET>`. User auth + CSRF are still enforced by the route handlers.

---

## Activation header

The client **opts in** to the signed transport by including:

```
X-Workalong-Client: active
```

(constant exported as `TRANSPORT_CLIENT_ACTIVE_HEADER` / `TRANSPORT_CLIENT_ACTIVE_VALUE` from `lib/transportClientHeader.js`)

Non-public endpoints that receive a request **without** this header are rejected with:

```json
{ "error": "Client protocol required", "message": "This endpoint must be called from a supported client." }
```

---

## Required request headers (non-public endpoints)

| Header | Description |
|---|---|
| `X-Workalong-Client: active` | Activates the signed transport (see above). |
| `X-Request-Timestamp` | Unix milliseconds (`Date.now()`). Must be within ±5 minutes of server time. |
| `X-Request-Nonce` | Random string, unique per request (prevents replay). |
| `X-Request-Signature` | Computed signature (see below). |
| `Content-Type: application/x-obfuscated` | Used when the body is XOR-encoded. |

---

## Key derivation

The obfuscation key is derived from the session ID and the current one-minute time bucket:

```
key = (sessionId + "_" + floor(timestampMs / 60000)).substring(0, 32)
```

- The key rotates every **60 seconds**.
- The timestamp used is taken from `X-Request-Timestamp`, so client and server must agree on the same millisecond value.
- For clock-in kiosk flows (no session cookie / Bearer token), the session ID is synthesised as:
  ```
  clocklink:<X-Link-Token>:<X-Device-Fingerprint>
  ```

---

## Request body format

The client XOR-encodes the JSON body with the derived key:

```
encoded_bytes[i] = plaintext_bytes[i] XOR key_bytes[i % key.length]
result = base64(encoded_bytes)
```

The request body sent to the server is a JSON wrapper:

```json
{ "format": "information", "data": "<base64-encoded XOR output>" }
```

An empty body is represented as `{ "format": "information", "data": "" }`.

The middleware deobfuscates this back to the original JSON and replaces `req.body` before the route handler runs.

---

## Request signature

The signature is a two-pass 32-bit djb2-style hash computed client-side and verified server-side.

**Input string:**

```
<METHOD>:<path>:<bodyString>:<timestamp>:<nonce>
```

- `<path>` is the endpoint path **without** the `/api` prefix (e.g. `/shifts/123`).
- `<bodyString>` is the raw `data` field from the obfuscated wrapper (the base64 string), or the JSON-serialised body if not using the wrapper.
- `<timestamp>` is the `X-Request-Timestamp` value (milliseconds string).
- `<nonce>` is the `X-Request-Nonce` value.

**Algorithm:**

```
pass1 = djb2(input_string)          // 32-bit signed integer
combined = pass1 + ":" + key        // key from key-derivation above
pass2 = djb2(combined)
signature = abs(pass2).toString(36) // base-36 string
```

where `djb2(s) = s.reduce((h, c) => Math.imul(h, 31) - h + c, 0)` (standard 32-bit variant).

The server recomputes the signature from the same inputs and rejects the request with `401 Invalid request signature` if they differ.

---

## Response body format

After signature verification and body deobfuscation, `obfuscateResponse` middleware wraps the outgoing `res.json(data)` call. Responses are encoded with the **same key** (derived from session + current minute):

```json
{ "format": "information", "data": "<base64 XOR-encoded JSON>" }
```

Conditions under which a response is obfuscated:
- The request was already obfuscated (`req.obfuscation.enabled`), **or**
- The client sent the activation header, the endpoint is not public, and the request had a body, **or**
- The endpoint is not public and the request is authenticated (`req.userId` or `req.staffId` is set).

The client XOR-decodes `data` with the same key to recover the original JSON.

---

## Public endpoints (no transport required)

These paths bypass the entire protocol — no activation header, no signature, no XOR body:

| Path |
|---|
| `/api/health` |
| `/api/contact` |
| `/api/demo-booking` |
| `/api/auth/public-csrf-token` |
| `/api/auth/signup` |
| `/api/auth/signin` |
| `/api/auth/forgot-password` |
| `/api/auth/reset-password` |
| `/api/auth/verify-code` |
| `/api/auth/csrf-token` |
| `/api/auth/session-id` |
| `/api/payment/webhook` |
| `/api/payment/config` |
| `/api/payment/verify-session` |
| `/api/clockin/clock-action` |
| `/api/clockin/verify-link/*` (prefix) |
| `/api/clockin/status/*` (prefix) |
| `/api/support/*` (prefix — handled by admin-panel-api) |

---

## Error responses

| Status | Error string | Cause |
|---|---|---|
| 400 | `Client protocol required` | Missing activation header on a non-public endpoint. |
| 400 | `Missing obfuscation headers` | One or more of timestamp / nonce / signature are absent. |
| 400 | `Request timestamp too old or invalid` | `abs(server_now - X-Request-Timestamp) > 5 minutes`. |
| 400 | `Failed to deobfuscate request body` | XOR decode or JSON parse error. |
| 401 | `Session required for obfuscated requests` | No session cookie, no `Authorization: Bearer`, and no clock-link headers. |
| 401 | `Invalid request signature` | Signature mismatch after key derivation. |
| 500 | `Obfuscation verification failed` | Unexpected exception in middleware. |

---

## Endpoint obfuscation (URL)

`deobfuscateEndpoint` is a separate helper (not used in the main request middleware path) that reverses a Caesar-rotated, base64-encoded path string:

```
decoded = base64_decode(caesar_derotate(obfuscated_string))
path    = "/" + decoded
```

The Caesar derotation shifts each alpha character back by its position index. This is used for any flows where the endpoint path itself is transmitted encoded.

---

## Sequence diagram

```
Client                                   Server
  |                                         |
  |  derive key = sessionId_bucket          |
  |  XOR-encode body → base64               |
  |  sign(METHOD:path:data:ts:nonce, key)   |
  |                                         |
  |── POST /api/shifts ─────────────────────►|
  |   X-Workalong-Client: active            |
  |   X-Request-Timestamp: <ms>             |
  |   X-Request-Nonce: <rand>               |
  |   X-Request-Signature: <sig>            |
  |   Body: { format, data: "<b64>" }       |
  |                                         |
  |                          verify ts ±5 min
  |                          derive same key
  |                          verify signature
  |                          XOR-decode body
  |                          → req.body = { … }
  |                          → route handler
  |                          XOR-encode response
  |                                         |
  |◄── 200 ─────────────────────────────────|
  |   Body: { format, data: "<b64>" }       |
  |                                         |
  |  XOR-decode response → JSON             |
```
