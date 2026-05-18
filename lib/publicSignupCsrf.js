
const PUBLIC_SIGNUP_CSRF_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, number>} token -> expiresAt (epoch ms) */
const issued = new Map();

const MAX_ENTRIES = 5000;

export function rememberPublicSignupCsrfToken(token) {
  const now = Date.now();
  const expiresAt = now + PUBLIC_SIGNUP_CSRF_TTL_MS;
  issued.set(token, expiresAt);
  if (issued.size > MAX_ENTRIES) {
    for (const [t, exp] of issued) {
      if (exp <= now) issued.delete(t);
    }
  }
}

export function consumePublicSignupCsrfToken(headerToken) {
  if (!headerToken || typeof headerToken !== 'string') return false;
  const exp = issued.get(headerToken);
  const now = Date.now();
  if (!exp || exp <= now) {
    if (exp) issued.delete(headerToken);
    return false;
  }
  issued.delete(headerToken);
  return true;
}

/** Remove token from the issued set without consuming (e.g. cookie double-submit matched). */
export function discardPublicSignupCsrfToken(token) {
  if (token && typeof token === 'string') issued.delete(token);
}
