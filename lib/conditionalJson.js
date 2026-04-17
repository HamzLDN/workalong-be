import crypto from 'crypto';

/**
 * Weak ETag for JSON payloads (stable for identical data).
 * @param {unknown} payload
 * @returns {string} e.g. W/"abc123..."
 */
export function weakEtagForJson(payload) {
  const body = JSON.stringify(payload);
  const hash = crypto.createHash('sha1').update(body).digest('hex');
  return `W/"${hash}"`;
}

/**
 * HTTP weak ETag match (If-None-Match can list several comma-separated values).
 * @param {string | undefined} ifNoneMatch
 * @param {string} etag
 */
export function ifNoneMatchSatisfied(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const normalize = (s) =>
    String(s)
      .trim()
      .replace(/^W\//i, '')
      .replace(/^"+|"+$/g, '');
  const want = normalize(etag);
  return ifNoneMatch.split(',').some((part) => normalize(part) === want);
}
