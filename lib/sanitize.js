/**
 * Sanitize strings to remove null bytes and other problematic characters
 * PostgreSQL doesn't allow null bytes (\x00) in text fields
 */

/**
 * Remove null bytes and other invalid UTF-8 sequences from a string
 * @param {string|number|null|undefined} value - The value to sanitize
 * @returns {string|null|number|undefined} - Sanitized value
 */
export function sanitizeString(value) {
  if (value === null || value === undefined) {
    return value;
  }
  
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  
  if (typeof value !== 'string') {
    // Convert to string first, then sanitize
    value = String(value);
  }
  
  // Remove null bytes (\x00) - PostgreSQL doesn't allow them
  // Also remove other control characters that could cause issues
  return value
    .replace(/\x00/g, '') // Remove null bytes
    .replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F]/g, '') // Remove other control chars except \n, \r, \t
    .trim();
}

/**
 * Sanitize an object by cleaning all string values recursively
 * @param {object} obj - Object to sanitize
 * @returns {object} - Sanitized object
 */
export function sanitizeObject(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj !== 'object') {
    return sanitizeString(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Middleware to sanitize request body
 */
export function sanitizeRequestBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

