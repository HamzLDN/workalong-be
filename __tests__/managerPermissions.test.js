import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_MANAGER_PERMISSIONS,
  mergePermissions,
  sanitizeManagerPermissions,
  managerPortalAllowed,
} from '../lib/managerPermissions.js';

describe('Manager permissions (portal security)', () => {
  it('returns defaults when stored is null or not an object', () => {
    expect(mergePermissions(null)).toEqual(DEFAULT_MANAGER_PERMISSIONS);
    expect(mergePermissions(undefined)).toEqual(DEFAULT_MANAGER_PERMISSIONS);
    expect(mergePermissions('x')).toEqual(DEFAULT_MANAGER_PERMISSIONS);
    expect(mergePermissions(1)).toEqual(DEFAULT_MANAGER_PERMISSIONS);
  });

  it('merges known features and preserves defaults for missing keys', () => {
    const merged = mergePermissions({
      schedule: { read: true, write: true },
    });
    expect(merged.schedule).toEqual({
      read: true,
      write: true,
      delete: false,
    });
    expect(merged.leave).toEqual(DEFAULT_MANAGER_PERMISSIONS.leave);
    expect(merged.overview.read).toBe(true);
  });

  it('ignores unknown feature keys in stored JSON (no expansion of attack surface)', () => {
    const merged = mergePermissions({
      admin: { superuser: true },
      schedule: { read: true },
    });
    expect(merged.admin).toBeUndefined();
    expect(merged.schedule.read).toBe(true);
  });

  it('sanitizeManagerPermissions keeps only known features and boolean ops', () => {
    const stored = sanitizeManagerPermissions({
      schedule: { read: true, write: 'yes', hack: true },
      admin: { superuser: true },
    });
    expect(stored).toEqual({ schedule: { read: true, write: true } });
    expect(stored.admin).toBeUndefined();
  });

  it('managerPortalAllowed reflects head-office grants after merge with defaults', () => {
    const stored = sanitizeManagerPermissions({
      schedule: { read: true, write: true },
      budget: { read: true },
    });
    expect(managerPortalAllowed(stored, 'schedule', 'read')).toBe(true);
    expect(managerPortalAllowed(stored, 'schedule', 'write')).toBe(true);
    expect(managerPortalAllowed(stored, 'schedule', 'delete')).toBe(false);
    expect(managerPortalAllowed(stored, 'budget', 'read')).toBe(true);
    expect(managerPortalAllowed(stored, 'leave', 'read')).toBe(false);
  });
});
