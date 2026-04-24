# Obfuscation System — Team Guide

This document explains how the obfuscation transport protocol works in `workalong-backend`.
The full technical spec lives in `OBFUSCATION.md`. This guide is meant to give your team
a plain-English understanding of why it exists and exactly how each part works.

---

## Why does this exist?

Every non-public API call in this backend goes through a signed transport layer. It does two things:

1. **Hides the request and response bodies** — the JSON is XOR-encoded before it leaves the client
   and before it leaves the server, so neither side sends readable plaintext over the wire.
2. **Prevents tampering and replays** — every request carries a signature tied to the session,
   the timestamp, and a one-time nonce. A copied or modified request is rejected.

This runs as Express middleware in `middleware/obfuscation.js` and fires before any route handler.

---

## The four moving parts

### 1. Key derivation

Before anything is encoded or signed, both the client and the server derive the same short key:

```
key = (sessionId + "_" + floor(timestampMs / 60000)).substring(0, 32)
```

- `sessionId` comes from the session cookie, a `Bearer` token, or (for kiosk flows) a combination
  of `X-Link-Token` and `X-Device-Fingerprint` headers prefixed with `clocklink:`.
- `floor(timestampMs / 60000)` is the current one-minute bucket — it changes every 60 seconds,
  so the key rotates automatically.
- Both sides use the same millisecond value from the `X-Request-Timestamp` header, which is how
  they stay in sync.

### 2. XOR body encoding

The client encodes the JSON request body like this:

```
encoded[i] = plaintext[i] XOR key[i % key.length]
result      = base64(encoded)
```

The encoded body is then wrapped and sent as:

```json
{ "format": "information", "data": "<base64 string>" }
```

An empty body is `{ "format": "information", "data": "" }`.

The server does the exact same XOR on the received base64 bytes to recover the original JSON,
then replaces `req.body` so route handlers never see the wrapper — they just get normal JSON.

The response is encoded the same way before it is sent back. The client decodes it with the
same XOR operation.

> XOR encoding is its own inverse: encoding and decoding are the same function.

### 3. Request signature

The client computes a signature and sends it in `X-Request-Signature`. The algorithm is a
two-pass djb2-style hash:

```
payload   = METHOD + ":" + path + ":" + base64Body + ":" + timestamp + ":" + nonce
pass1     = djb2(payload)
combined  = pass1 + ":" + key
signature = abs(djb2(combined)).toString(36)
```

- `path` is the endpoint path **without** the `/api` prefix (e.g. `/shifts/123`).
- `timestamp` is `X-Request-Timestamp` (Unix milliseconds).
- `nonce` is `X-Request-Nonce` — a random string that must be unique per request.

The server recomputes the same signature from the same inputs. If they don't match, the
request is rejected with `401 Invalid request signature`.

### 4. Timestamp + nonce window

The server checks that `|serverNow - X-Request-Timestamp| <= 5 minutes`. Any request outside
that window is rejected. Combined with the nonce (which must be unique), this prevents both
clock-skew abuse and replay attacks.

---

## Request flow, step by step

```
Client                                         Server
  |                                               |
  |  1. derive key = sessionId_minuteBucket       |
  |  2. XOR-encode JSON body → base64             |
  |  3. sign(METHOD:path:data:ts:nonce, key)       |
  |                                               |
  |── POST /api/shifts ────────────────────────► |
  |   X-Workalong-Client: active                  |
  |   X-Request-Timestamp: <ms>                   |
  |   X-Request-Nonce: <random>                   |
  |   X-Request-Signature: <base36>               |
  |   Content-Type: application/x-obfuscated      |
  |   Body: { "format": "information",            |
  |           "data": "<base64>" }                |
  |                                               |
  |                        4. check ts ± 5 min    |
  |                        5. derive same key      |
  |                        6. verify signature     |
  |                        7. XOR-decode body      |
  |                        8. req.body = { … }    |
  |                        9. route handler runs   |
  |                       10. XOR-encode response  |
  |                                               |
  |◄── 200 ────────────────────────────────────── |
  |   Body: { "format": "information",            |
  |           "data": "<base64>" }                |
  |                                               |
  |  11. XOR-decode response → normal JSON        |
```

---

## Required headers for non-public endpoints

| Header | Value | Purpose |
|---|---|---|
| `X-Workalong-Client` | `active` | Activates the signed transport |
| `X-Request-Timestamp` | Unix ms (`Date.now()`) | Used for key derivation and replay check |
| `X-Request-Nonce` | Any unique random string | Prevents replay attacks |
| `X-Request-Signature` | Computed base-36 hash | Proves request integrity |
| `Content-Type` | `application/x-obfuscated` | Signals that the body is XOR-encoded |

---

## Bypasses

### Development / CI

Run the server with `NODE_ENV=dev` and `DISABLE_OBFUSCATION=true` (what `npm run dev` does).
The middleware skips signature verification and XOR coding, so you can use plain JSON with
curl or Postman.

- If a client still sends the activation header and all signature headers, they **are** validated
  even in dev mode. This lets security tests run against the local server.
- If the body arrives in the `{ format, data }` wrapper in dev mode, the middleware still
  decodes it so route handlers receive normal JSON.

### Trusted internal services

Services like `workalong-ai` can skip obfuscation by sending:

```
X-Workalong-Internal-Secret: <INTERNAL_SERVICE_SECRET>
```

where `INTERNAL_SERVICE_SECRET` is a shared env variable. User auth and CSRF are still
enforced by the individual route handlers.

### Public endpoints

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
| `/api/support/*` (prefix) |

---

## Error reference

| Status | Error | What went wrong |
|---|---|---|
| 400 | `Client protocol required` | `X-Workalong-Client: active` header was missing |
| 400 | `Missing obfuscation headers` | One or more of timestamp / nonce / signature absent |
| 400 | `Request timestamp too old or invalid` | Clock skew > 5 minutes |
| 400 | `Failed to deobfuscate request body` | XOR decode or JSON parse failed |
| 401 | `Session required for obfuscated requests` | No session cookie, Bearer token, or clock-link headers |
| 401 | `Invalid request signature` | Signature mismatch |
| 500 | `Obfuscation verification failed` | Unexpected exception in middleware |

---

## Key files

| File | Purpose |
|---|---|
| `middleware/obfuscation.js` | All middleware: key derivation, XOR encode/decode, signature logic |
| `lib/transportClientHeader.js` | Exports the `X-Workalong-Client` header name and value constants |
| `docs/OBFUSCATION.md` | Full technical specification |
| `__tests__/obfuscation-public-endpoints.test.js` | Tests covering which endpoints are treated as public |
