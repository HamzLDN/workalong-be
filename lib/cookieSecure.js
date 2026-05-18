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

export function sessionCookieDomain(req) {
  if (process.env.SESSION_COOKIE_DOMAIN) {
    return process.env.SESSION_COOKIE_DOMAIN;
  }
  try {
    const h = String(req.hostname || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (h === 'workalong.co.uk' || h.endsWith('.workalong.co.uk')) {
      return '.workalong.co.uk';
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Standard employer session cookie options (httpOnly sessionId). */
export function sessionCookieOptions(req, overrides = {}) {
  const opts = {
    httpOnly: true,
    secure: cookieSecure(req),
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
    ...overrides,
  };
  const domain = sessionCookieDomain(req);
  if (domain) opts.domain = domain;
  return opts;
}
