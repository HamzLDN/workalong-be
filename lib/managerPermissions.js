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

/** @param {unknown} stored */
export function mergePermissions(stored) {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_MANAGER_PERMISSIONS };
  const merged = {};
  for (const [feature, defaults] of Object.entries(DEFAULT_MANAGER_PERMISSIONS)) {
    merged[feature] = { ...defaults, ...(stored[feature] || {}) };
  }
  return merged;
}
