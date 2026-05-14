/**
 * Whether to set the `Secure` flag on Set-Cookie.
 * Using only NODE_ENV breaks local HTTP dev when the API runs with NODE_ENV=production
 * (e.g. Docker): browsers ignore Secure cookies on http://localhost, so public CSRF + sessions fail.
 *
 * Trust-proxy + X-Forwarded-Proto=https can also mark "secure" while the browser still used HTTP
 * to the dev server (e.g. Next on :3000 → API on :8081). Loopback hostnames never get Secure so
 * the cookie is actually stored on http://localhost.
 *
 * Override: COOKIE_SECURE=true | false
 */
function loopbackHostname(hostname) {
  const h = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!h) return false;
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '::ffff:127.0.0.1' ||
    h === '0.0.0.0'
  );
}

export function cookieSecure(req) {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  try {
    if (loopbackHostname(req.hostname)) return false;
  } catch {
    /* ignore */
  }
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}
