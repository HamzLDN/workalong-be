/**
 * Conservative RFC-style employer email validation (ASCII-ish).
 * Rejects shell/command characters and malformed domains so payloads like
 * "user@domain; rm -rf /" fail validation instead of persisting verbatim.
 */

const EMPLOYER_EMAIL_RE =
  /^[a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** Max total length per RFC-style guidance */
const EMAIL_MAX_LENGTH = 254;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEmployerEmail(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) {
    return false;
  }
  return EMPLOYER_EMAIL_RE.test(trimmed);
}
