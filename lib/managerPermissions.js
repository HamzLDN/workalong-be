/**
 * Manager portal permission matrix: defaults and merge with stored JSON from users.manager_permissions.
 * Head office configures via PUT /api/staff/manager-permissions; portal routes enforce merged values.
 */

export const DEFAULT_MANAGER_PERMISSIONS = {
  overview: { read: true },
  staff: { read: true, write: false, delete: false },
  hours: { read: true, write: false, delete: false },
  leave: { read: false, write: false, delete: false },
  budget: { read: false },
  schedule: { read: false, write: false, delete: false },
  audit: { read: false },
};

export const MANAGER_PERMISSION_OPS = {
  overview: ['read'],
  staff: ['read', 'write', 'delete'],
  hours: ['read', 'write', 'delete'],
  leave: ['read', 'write', 'delete'],
  budget: ['read'],
  schedule: ['read', 'write', 'delete'],
  audit: ['read'],
};

/** @param {unknown} stored */
export function mergePermissions(stored) {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_MANAGER_PERMISSIONS };
  const merged = {};
  for (const [feature, defaults] of Object.entries(DEFAULT_MANAGER_PERMISSIONS)) {
    merged[feature] = { ...defaults, ...(stored[feature] || {}) };
  }
  return merged;
}

/**
 * Head-office PUT body → JSON stored on users.manager_permissions.
 * @param {unknown} permissions
 */
export function sanitizeManagerPermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') return {};
  const sanitised = {};
  for (const feature of Object.keys(MANAGER_PERMISSION_OPS)) {
    if (!permissions[feature] || typeof permissions[feature] !== 'object') continue;
    const ops = MANAGER_PERMISSION_OPS[feature];
    sanitised[feature] = {};
    for (const op of ops) {
      if (op in permissions[feature]) {
        sanitised[feature][op] = Boolean(permissions[feature][op]);
      }
    }
  }
  return sanitised;
}

/** @param {unknown} stored @param {string} feature @param {string} op */
export function managerPortalAllowed(stored, feature, op) {
  const perms = mergePermissions(stored);
  return Boolean(perms[feature]?.[op]);
}
